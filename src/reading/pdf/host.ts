/**
 * Runs the PDF reader as a child process per file and task, and turns what happens to that process
 * into a result the caller understands. A process that reports no page for a while, or runs too long
 * in total, is killed; that and a crash are interruptions of this one document, which then continues
 * without pdf.js (concept §6.2). Loupe's own process never touches pdf.js.
 */
import { fork } from 'node:child_process';
import { Semaphore } from '../../core/semaphore.ts';
import type {
    PdfDocumentInfo,
    PdfReaderPage,
    PdfReaderPhase,
    PdfReaderRequest,
    PdfReaderResult,
    PdfReaderWarning,
} from './messages.ts';

/** Bytes of the child's stderr kept for the error message; enough for a stack, not a log. */
const STDERR_TAIL_BYTES = 4096;

/**
 * The environment the reader gets: what Node and the native libraries need to run, and nothing else:
 * no credentials, no connection strings, and no NODE_OPTIONS whose heap flag would override the cap.
 */
const READER_ENV_KEYS = ['PATH', 'HOME', 'NODE_ENV', 'TMPDIR', 'NODE_V8_COVERAGE'];

/** The reader's entry: this file's sibling, compiled or as source. */
export const PDF_READER_ENTRY = new URL(import.meta.url.endsWith('.ts') ? './child.ts' : './child.js', import.meta.url);

export interface PdfReaderHostOptions {
    /** The script forked per task. */
    entry: URL;
    /** Opening the file, before any page, may take this long without a sign of life. */
    openTimeoutMs: number;
    /** A page that takes longer than this without the process reporting the next one counts as stuck. */
    idleTimeoutMs: number;
    /** No task takes longer than this. */
    totalTimeoutMs: number;
    /** Reader processes at once. */
    maxConcurrent: number;
    /** The heap cap of one reader process. */
    maxHeapMb: number;
}

/** What the reader delivered for a PDF it could open. */
export interface PdfReaderOutput {
    info: PdfDocumentInfo;
    pageCount: number;
    pages: PdfReaderPage[];
}

/** The process reading a PDF was killed or died before it answered. */
export class PdfReaderInterruptedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PdfReaderInterruptedError';
    }
}

export interface PdfReaderLogger {
    warn(details: object, message: string): void;
}

export class PdfReaderHost {
    readonly #options: PdfReaderHostOptions;
    readonly #slots: Semaphore;
    readonly #log: PdfReaderLogger;

    constructor(options: PdfReaderHostOptions, log: PdfReaderLogger) {
        this.#options = options;
        this.#slots = new Semaphore(options.maxConcurrent);
        this.#log = log;
    }

    /**
     * Reads the pages asked for. Resolves undefined when pdf.js cannot open the file; rejects with
     * `PdfReaderInterruptedError` when the process is killed or dies, and with a plain error when no
     * process could be started.
     */
    run(request: PdfReaderRequest, signal: AbortSignal): Promise<PdfReaderOutput | undefined> {
        return this.#slots.run(async () => {
            signal.throwIfAborted();
            const { output, closed } = this.#spawn(request, signal);
            try {
                return await output;
            } finally {
                await closed;
            }
        });
    }

    #spawn(request: PdfReaderRequest, signal: AbortSignal) {
        const { entry, openTimeoutMs, idleTimeoutMs, totalTimeoutMs } = this.#options;
        const child = fork(entry, [], {
            serialization: 'advanced',
            execArgv: this.#execArgv(),
            env: readerEnv(),
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let spawned = false;
        child.once('spawn', () => {
            spawned = true;
        });
        const closed = new Promise<void>((resolve) => {
            child.once('close', () => resolve());
            // A process that never started emits no `close`.
            child.once('error', () => {
                if (!spawned) resolve();
            });
        });
        let stderrTail = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
        });
        child.stderr?.on('error', () => undefined);

        const output = new Promise<PdfReaderOutput | undefined>((resolve, reject) => {
            // Whatever ends the process first (answer, death, deadline, abort) settles the promise once,
            // and the process is killed on every path; SIGKILL is the one signal native code cannot ignore.
            let settled = false;
            let opened = false;
            let pageReached = 0;
            let phaseReached: PdfReaderPhase = 'open';
            let idleTimer: NodeJS.Timeout | undefined;
            const totalTimer = setTimeout(
                () => interrupt(`gave no result within ${totalTimeoutMs} ms`),
                totalTimeoutMs
            );
            const armIdleTimer = () => {
                clearTimeout(idleTimer);
                idleTimer = opened
                    ? setTimeout(
                          () =>
                              interrupt(
                                  `made no progress for ${idleTimeoutMs} ms after page ${pageReached} (${phaseReached})`
                              ),
                          idleTimeoutMs
                      )
                    : setTimeout(() => interrupt(`did not open the file within ${openTimeoutMs} ms`), openTimeoutMs);
            };
            const onAbort = () => settle(() => reject(signal.reason));
            const settle = (outcome: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(totalTimer);
                clearTimeout(idleTimer);
                signal.removeEventListener('abort', onAbort);
                child.kill('SIGKILL');
                outcome();
            };
            const interrupt = (detail: string) =>
                settle(() => {
                    const tail = stderrTail.trim();
                    reject(new PdfReaderInterruptedError(`The PDF reader process ${detail}${tail ? `: ${tail}` : ''}`));
                });
            signal.addEventListener('abort', onAbort, { once: true });

            child.on('message', (message: PdfReaderResult) => {
                if (message.type === 'progress') {
                    opened = true;
                    pageReached = message.pageNumber;
                    phaseReached = message.phase;
                    armIdleTimer();
                    return;
                }
                settle(() => {
                    if (message.type === 'open-failed') {
                        this.#log.warn({ reason: message.message }, 'pdf.js could not open the PDF');
                        resolve(undefined);
                        return;
                    }
                    this.#report(message.warnings);
                    resolve({ info: message.info, pageCount: message.pageCount, pages: message.pages });
                });
            });
            child.on('error', (error) => {
                if (spawned) interrupt(`failed: ${error.message}`);
                else settle(() => reject(new Error(`The PDF reader process could not be started: ${error.message}`)));
            });
            // `close` follows the last message on the channel; `exit` could beat a result still in flight.
            child.on('close', (code, signalName) => {
                interrupt(`exited before answering (code ${code ?? 'null'}, signal ${signalName ?? 'null'})`);
            });
            child.send(request, () => undefined);
            armIdleTimer();
        });
        return { output, closed };
    }

    #report(warnings: PdfReaderWarning[]): void {
        for (const warning of warnings) {
            this.#log.warn(
                { page: warning.pageNumber, phase: warning.phase, reason: warning.message },
                'pdf.js page failed'
            );
        }
    }

    /** This process's Node flags (the source loader in development), minus test, debug and heap flags, plus the cap. */
    #execArgv(): string[] {
        return [
            ...process.execArgv.filter(
                (arg) =>
                    !arg.startsWith('--max-old-space-size') && !arg.startsWith('--test') && !arg.startsWith('--inspect')
            ),
            `--max-old-space-size=${this.#options.maxHeapMb}`,
        ];
    }
}

const readerEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of READER_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    return env;
};
