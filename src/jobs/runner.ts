import { createHash } from 'node:crypto';
import type { LimitsConfig } from '../config/env.ts';
import type { Loggers } from '../core/logger.ts';
import { DocumentError } from '../reading/errors.ts';
import { parsePageSelection } from '../reading/pages.ts';
import type { ReadRequest, ReadResult } from '../reading/types.ts';
import { jobIdOfQueueEntry, paths } from '../store/paths.ts';
import { getJson, putJson, type Store } from '../store/store.ts';
import { FINAL_DOCUMENT_STATUSES, type JobRecord, type JobState } from './model.ts';
import { extensionOf, manifestOf, renderResult } from './results.ts';

/**
 * Runs jobs (concept §6.4). Every replica polls the queue and leases jobs; only the lease holder
 * writes a job's state. A lapsed lease lets another replica take the job over: succeeded documents
 * stay, running ones start again. Documents of the leased jobs are started round-robin, so a large
 * batch does not hold back a small job.
 */

const POLL_INTERVAL_MS = 2000;
const LEASE_SECONDS = 60;
const RENEW_INTERVAL_MS = 15_000;
const STATE_WRITE_INTERVAL_MS = 5000;
const SHUTDOWN_GRACE_MS = 5000;

/** Why a running document was stopped. */
type StopReason = 'cancel' | 'deadline' | 'shutdown' | 'lease-lost';

class Stop extends Error {
    readonly reason: StopReason;

    constructor(reason: StopReason) {
        super(`stopped: ${reason}`);
        this.reason = reason;
    }
}

/** What reads a document: the document reader, or a stand-in in tests. */
export interface Reader {
    read(request: ReadRequest): Promise<ReadResult>;
}

interface ActiveJob {
    job: JobRecord;
    state: JobState;
    leaseId: string;
    running: Map<number, AbortController>;
    cancelRequested: boolean;
    dirty: boolean;
    lastWrite: number;
    /** Set once the lease is gone: nothing more is written. */
    lost: boolean;
    renewTimer: NodeJS.Timeout;
    writing: Promise<void>;
}

export class JobRunner {
    readonly #store: Store;
    readonly #reader: Reader;
    readonly #limits: LimitsConfig;
    readonly #loggers: Loggers;
    readonly #active = new Map<string, ActiveJob>();
    #inFlight = 0;
    #turn = 0;
    #timer: NodeJS.Timeout | undefined;
    #polling: Promise<void> | undefined;
    #stopping = false;

    constructor(options: { store: Store; reader: Reader; limits: LimitsConfig; loggers: Loggers }) {
        this.#store = options.store;
        this.#reader = options.reader;
        this.#limits = options.limits;
        this.#loggers = options.loggers;
    }

    start(): void {
        this.#timer = setInterval(() => this.wake(), POLL_INTERVAL_MS);
        this.wake();
    }

    /** Polls now: after a local submit or cancel, and on every interval. */
    wake(): void {
        if (this.#stopping || this.#polling) return;
        this.#polling = this.#poll()
            .catch((error: unknown) => this.#loggers.log.warn({ err: error }, 'job poll failed'))
            .finally(() => {
                this.#polling = undefined;
            });
    }

    async #poll(): Promise<void> {
        if (this.#active.size < this.#limits.maxActiveJobs) {
            for await (const entry of this.#store.list(paths.queue)) {
                if (this.#stopping || this.#active.size >= this.#limits.maxActiveJobs) break;
                const jobId = jobIdOfQueueEntry(entry);
                if (this.#active.has(jobId)) continue;
                await this.#take(entry, jobId);
            }
        }
        for (const active of this.#active.values()) await this.#check(active);
        this.#schedule();
        for (const active of [...this.#active.values()]) {
            if (active.dirty && Date.now() - active.lastWrite >= STATE_WRITE_INTERVAL_MS) await this.#write(active);
        }
    }

    /** Leases the job and continues it where it stands. */
    async #take(entry: string, jobId: string): Promise<void> {
        const leaseId = await this.#store.acquireLease(entry, LEASE_SECONDS);
        if (!leaseId) return;
        const [job, state] = await Promise.all([
            getJson<JobRecord>(this.#store, paths.job(jobId)),
            getJson<JobState>(this.#store, paths.state(jobId)),
        ]);
        if (!job || !state) {
            await this.#store.deleteLeased(entry, leaseId);
            return;
        }
        // documents that were running when the previous holder stopped start again
        for (const document of state.documents) {
            if (document.status === 'running') {
                document.status = 'queued';
                delete document.pagesDone;
                delete document.pagesTotal;
            }
        }
        state.status = 'running';
        state.startedAt ??= new Date().toISOString();
        const active: ActiveJob = {
            job,
            state,
            leaseId,
            running: new Map(),
            cancelRequested: false,
            dirty: true,
            lastWrite: 0,
            lost: false,
            renewTimer: setInterval(() => void this.#renew(active), RENEW_INTERVAL_MS),
            writing: Promise.resolve(),
        };
        this.#active.set(jobId, active);
        this.#loggers.log.info({ jobId, documents: job.files.length }, 'job taken');
        await this.#check(active);
        await this.#write(active);
    }

    async #renew(active: ActiveJob): Promise<void> {
        if (active.lost) return;
        const renewed = await this.#store.renewLease(active.job.queueEntry, active.leaseId).catch(() => false);
        if (!renewed) this.#lose(active);
    }

    /** The lease is gone: another replica may hold the job now, so this one stops without writing. */
    #lose(active: ActiveJob): void {
        if (active.lost) return;
        active.lost = true;
        clearInterval(active.renewTimer);
        this.#active.delete(active.job.jobId);
        for (const controller of active.running.values()) controller.abort(new Stop('lease-lost'));
        this.#loggers.log.warn({ jobId: active.job.jobId }, 'job lease lost');
    }

    /** Cancellation and the job's deadline. */
    async #check(active: ActiveJob): Promise<void> {
        if (!active.cancelRequested && (await this.#store.head(paths.cancel(active.job.jobId)))) {
            active.cancelRequested = true;
            this.#settleQueued(active, { status: 'cancelled' });
            for (const controller of active.running.values()) controller.abort(new Stop('cancel'));
        }
        if (Date.now() > Date.parse(active.job.createdAt) + this.#limits.maxJobDurationMs) {
            this.#settleQueued(active, {
                status: 'failed',
                error: { code: 'timeout', message: 'The job reached its maximum duration' },
            });
            for (const controller of active.running.values()) controller.abort(new Stop('deadline'));
        }
        await this.#completeIfDone(active);
    }

    #settleQueued(active: ActiveJob, outcome: Pick<JobState['documents'][number], 'status' | 'error'>): void {
        for (const [index, document] of active.state.documents.entries()) {
            if (document.status === 'queued') {
                active.state.documents[index] = outcome.error
                    ? { status: outcome.status, error: outcome.error }
                    : { status: outcome.status };
                active.dirty = true;
            }
        }
    }

    /** Starts queued documents while slots are free, taking the leased jobs in turn. */
    #schedule(): void {
        if (this.#stopping) return;
        while (this.#inFlight < this.#limits.analysisConcurrency) {
            const jobs = [...this.#active.values()];
            if (jobs.length === 0) return;
            let started = false;
            for (let offset = 0; offset < jobs.length && !started; offset++) {
                const active = jobs[(this.#turn + offset) % jobs.length] as ActiveJob;
                const index = active.state.documents.findIndex((document) => document.status === 'queued');
                if (index < 0 || active.cancelRequested) continue;
                this.#turn = (this.#turn + offset + 1) % jobs.length;
                this.#startDocument(active, index);
                started = true;
            }
            if (!started) return;
        }
    }

    #startDocument(active: ActiveJob, index: number): void {
        const controller = new AbortController();
        active.running.set(index, controller);
        active.state.documents[index] = { status: 'running' };
        active.dirty = true;
        this.#inFlight++;
        void this.#readDocument(active, index, controller.signal).finally(() => {
            active.running.delete(index);
            this.#inFlight--;
            void this.#completeIfDone(active).finally(() => this.#schedule());
        });
    }

    async #readDocument(active: ActiveJob, index: number, signal: AbortSignal): Promise<void> {
        const { job } = active;
        const file = job.files[index];
        if (!file) return;
        const document = active.state.documents[index] as JobState['documents'][number];
        try {
            const content = await this.#store.get(paths.uploadFile(job.uploadId, file.key));
            if (!content || createHash('sha256').update(content).digest('hex') !== file.sha256) {
                throw new DocumentError('internal', 'The uploaded file is no longer available');
            }
            const result = await this.#reader.read({
                name: file.name,
                type: file.type,
                content,
                quality: job.quality,
                language: job.language,
                pages: job.pages ? parsePageSelection(job.pages) : undefined,
                signal,
                progress: (done, total) => {
                    document.pagesDone = done;
                    document.pagesTotal = total;
                    active.dirty = true;
                },
            });
            signal.throwIfAborted();
            const rendered = renderResult(result);
            await this.#store.put(
                paths.result(job.jobId, index, extensionOf(result.format)),
                rendered.body,
                result.format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8'
            );
            active.state.documents[index] = {
                status: 'succeeded',
                format: result.format,
                pages: rendered.pages,
                bytes: rendered.body.length,
                sha256: rendered.sha256,
            };
            this.#loggers.audit.info(
                { jobId: job.jobId, document: file.name, pages: rendered.pages.length, quality: job.quality },
                'document read'
            );
        } catch (error) {
            const stop = signal.aborted && signal.reason instanceof Stop ? signal.reason.reason : undefined;
            if (stop === 'shutdown' || stop === 'lease-lost') {
                active.state.documents[index] = { status: 'queued' };
            } else if (stop === 'cancel') {
                active.state.documents[index] = { status: 'cancelled' };
            } else if (stop === 'deadline') {
                active.state.documents[index] = {
                    status: 'failed',
                    error: { code: 'timeout', message: 'The job reached its maximum duration' },
                };
            } else if (error instanceof DocumentError) {
                active.state.documents[index] = {
                    status: 'failed',
                    error: { code: error.code, message: error.message },
                };
            } else {
                this.#loggers.log.error({ err: error, jobId: job.jobId, document: file.name }, 'document failed');
                active.state.documents[index] = {
                    status: 'failed',
                    error: { code: 'internal', message: 'Reading the document failed unexpectedly' },
                };
            }
        }
        active.dirty = true;
        if (!active.lost && !this.#stopping) await this.#write(active);
    }

    /** Writes state and manifest, one write at a time per job. */
    #write(active: ActiveJob): Promise<void> {
        const next = active.writing.then(async () => {
            if (active.lost || !active.dirty) return;
            active.dirty = false;
            active.lastWrite = Date.now();
            active.state.updatedAt = new Date().toISOString();
            await putJson(this.#store, paths.state(active.job.jobId), active.state);
            await putJson(this.#store, paths.manifest(active.job.jobId), manifestOf(active.job, active.state));
        });
        active.writing = next.catch((error: unknown) => {
            active.dirty = true;
            this.#loggers.log.warn({ err: error, jobId: active.job.jobId }, 'job state write failed');
        });
        return active.writing;
    }

    async #completeIfDone(active: ActiveJob): Promise<void> {
        if (active.lost || this.#stopping || !this.#active.has(active.job.jobId)) return;
        if (active.running.size > 0) return;
        if (!active.state.documents.every((document) => FINAL_DOCUMENT_STATUSES.has(document.status))) return;
        this.#active.delete(active.job.jobId);
        clearInterval(active.renewTimer);
        active.state.status = active.cancelRequested ? 'cancelled' : 'completed';
        active.state.completedAt = new Date().toISOString();
        active.dirty = true;
        await this.#write(active);
        await this.#store.deleteLeased(active.job.queueEntry, active.leaseId).catch((error: unknown) => {
            this.#loggers.log.warn({ err: error, jobId: active.job.jobId }, 'queue entry not deleted');
        });
        this.#loggers.log.info({ jobId: active.job.jobId, status: active.state.status }, 'job finished');
    }

    /**
     * Stops taking documents, aborts the running ones, writes the state of every job and releases the
     * leases, so another replica continues at once (concept §6.4).
     */
    async shutdown(): Promise<void> {
        this.#stopping = true;
        clearInterval(this.#timer);
        await this.#polling;
        const jobs = [...this.#active.values()];
        for (const active of jobs) {
            clearInterval(active.renewTimer);
            for (const controller of active.running.values()) controller.abort(new Stop('shutdown'));
        }
        const deadline = Date.now() + SHUTDOWN_GRACE_MS;
        while (this.#inFlight > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        for (const active of jobs) {
            if (active.lost) continue;
            for (const [index] of active.running) active.state.documents[index] = { status: 'queued' };
            active.dirty = true;
            await this.#write(active);
            await this.#store.releaseLease(active.job.queueEntry, active.leaseId);
        }
        this.#active.clear();
    }
}
