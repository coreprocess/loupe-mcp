import type { ServiceConfig } from '../../config/env.ts';
import type { Loggers } from '../../core/logger.ts';
import { sleep } from '../../core/sleep.ts';
import { DocumentError } from '../errors.ts';
import { authenticator, fetchWithRetries, misconfigured, readJson } from './http.ts';

/**
 * Azure Document Intelligence, `prebuilt-layout` with Markdown output (concept §6.1). The file goes
 * to the service as the request body; the analysis runs as a long-running operation that is polled.
 */

const API_VERSION = '2024-11-30';
const ANALYSIS_TIMEOUT_MS = 20 * 60_000;
const ANALYSIS_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 10_000;

export interface AnalyzeOptions {
    /** The `ocrHighResolution` add-on; only for PDFs and images. */
    highResolution: boolean;
    locale: string | undefined;
    /** A page selection in the service's syntax (`1-3,7`). */
    pages: string | undefined;
    signal: AbortSignal;
}

/** One page of the transcript. */
export interface LayoutPage {
    number: number;
    markdown: string;
}

/** The service refused the file itself; a verdict about the bytes, never retried. */
export class AnalysisRefusedError extends DocumentError {
    constructor(message: string) {
        super('unreadable', message);
        this.name = 'AnalysisRefusedError';
    }
}

interface AnalyzeOperation {
    status?: string;
    error?: { code?: string; message?: string; innererror?: { code?: string; message?: string } };
    analyzeResult?: { content?: string; pages?: { pageNumber?: number }[] };
}

const PAGE_BREAK = '<!-- PageBreak -->';
const PAGE_NUMBER_COMMENT = /<!--\s*PageNumber="[^"]*"\s*-->\n?/g;

/**
 * The Markdown split into pages at the service's page breaks. Page numbers come from the service's
 * page list; the page-number comments are dropped, headers and footers stay as the service marks them.
 */
export const splitLayoutPages = (content: string, pages: { pageNumber?: number }[]): LayoutPage[] => {
    const segments = content.replace(PAGE_NUMBER_COMMENT, '').split(PAGE_BREAK);
    while (segments.length > Math.max(pages.length, 1) && segments.at(-1)?.trim() === '') segments.pop();
    const numbers = segments.length === pages.length ? pages.map((page, i) => page.pageNumber ?? i + 1) : undefined;
    return segments.map((segment, i) => ({ number: numbers?.[i] ?? i + 1, markdown: segment.trim() }));
};

const describeError = (error: AnalyzeOperation['error']): string => {
    const inner = error?.innererror?.code ? ` (${error.innererror.code})` : '';
    return `${error?.code ?? 'Error'}${inner}: ${error?.message ?? 'no message'}`;
};

export class DocumentIntelligence {
    readonly #endpoint: string;
    readonly #auth: () => Promise<Record<string, string>>;
    readonly #loggers: Loggers;

    constructor(service: ServiceConfig, loggers: Loggers) {
        this.#endpoint = service.endpoint;
        this.#auth = authenticator(service, 'ocp-apim-subscription-key');
        this.#loggers = loggers;
    }

    /**
     * The layout transcript per page. Throws `AnalysisRefusedError` when the service refuses the file,
     * `DocumentError('timeout')` when no attempt finishes in time, and `service_unavailable` after the
     * retries.
     */
    async analyzeLayout(content: Buffer, options: AnalyzeOptions): Promise<LayoutPage[]> {
        for (let attempt = 1; attempt <= ANALYSIS_ATTEMPTS; attempt++) {
            const result = await this.#analyzeOnce(content, options);
            if (result) return splitLayoutPages(result.content ?? '', result.pages ?? []);
            this.#loggers.log.info({ attempt }, 'Document Intelligence analysis did not finish in time');
        }
        throw new DocumentError(
            'timeout',
            `Document Intelligence did not finish the analysis within ${ANALYSIS_ATTEMPTS} attempts`
        );
    }

    /** One analysis; undefined when it does not finish within its time. */
    async #analyzeOnce(
        content: Buffer,
        options: AnalyzeOptions
    ): Promise<NonNullable<AnalyzeOperation['analyzeResult']> | undefined> {
        const url = new URL(`${this.#endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze`);
        url.searchParams.set('api-version', API_VERSION);
        url.searchParams.set('outputContentFormat', 'markdown');
        if (options.highResolution) url.searchParams.set('features', 'ocrHighResolution');
        if (options.locale) url.searchParams.set('locale', options.locale);
        if (options.pages) url.searchParams.set('pages', options.pages);
        const retry = {
            what: 'Document Intelligence',
            signal: options.signal,
            attemptTimeoutMs: REQUEST_TIMEOUT_MS,
            loggers: this.#loggers,
        };
        const started = await fetchWithRetries(
            url.href,
            async () => ({
                method: 'POST',
                headers: { ...(await this.#auth()), 'content-type': 'application/octet-stream' },
                body: content,
            }),
            retry
        );
        if (started.status !== 202) {
            const body = await readJson(started);
            if ([401, 403, 404].includes(started.status))
                throw misconfigured(retry.what, started.status, this.#loggers);
            throw new AnalysisRefusedError(
                `Document Intelligence refused the file: ${describeError(body.error as AnalyzeOperation['error'])}`
            );
        }
        await started.body?.cancel();
        const operation = started.headers.get('operation-location');
        if (!operation) throw new DocumentError('internal', 'Document Intelligence answered without an operation');

        const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
        let interval = POLL_INTERVAL_MS;
        while (Date.now() < deadline) {
            await sleep(interval, options.signal);
            interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
            const response = await fetchWithRetries(operation, async () => ({ headers: await this.#auth() }), retry);
            const body = (await readJson(response)) as AnalyzeOperation;
            if (!response.ok) {
                if ([401, 403, 404].includes(response.status)) {
                    throw misconfigured(retry.what, response.status, this.#loggers);
                }
                throw new DocumentError('internal', `Document Intelligence: HTTP ${response.status}`);
            }
            if (body.status === 'succeeded') return body.analyzeResult ?? {};
            if (body.status === 'failed') {
                // a server error is an outage, retried as a new analysis; every other code is about the file
                if (body.error?.code === 'InternalServerError') return undefined;
                throw new AnalysisRefusedError(`Document Intelligence failed the file: ${describeError(body.error)}`);
            }
        }
        return undefined;
    }
}
