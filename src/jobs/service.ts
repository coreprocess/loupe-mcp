import type { LimitsConfig } from '../config/env.ts';
import { LoupeError } from '../core/errors.ts';
import { isId, newId } from '../core/ids.ts';
import type { Loggers } from '../core/logger.ts';
import { sleep } from '../core/sleep.ts';
import { parsePageSelection } from '../reading/pages.ts';
import type { Quality } from '../reading/types.ts';
import { jobIdOfQueueEntry, paths } from '../store/paths.ts';
import { getJson, putJson, type Store } from '../store/store.ts';
import type { UploadService } from '../uploads/uploads.ts';
import type { Caller, JobRecord, JobState, JobStatus, UploadedFile, UploadRecord } from './model.ts';
import { isFinalJobStatus } from './model.ts';
import { jobStatusOf, manifestOf, pageContent } from './results.ts';

/** `get_job` waits at most this long for a change (concept §5.3). */
export const MAX_WAIT_MS = 10_000;
const WAIT_POLL_MS = 500;
const CANCEL_WAIT_MS = 5000;

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export interface JobSnapshot {
    job: JobRecord;
    state: JobState;
    status: JobStatus;
}

export interface SubmitRequest {
    uploadId: string;
    quality: Quality;
    files: string[] | undefined;
    language: string | undefined;
    pages: string | undefined;
}

export interface PageWindow {
    document: string;
    format: string;
    pageCount: number;
    pages: { number: number; method: string; content: string; truncated?: true }[];
    nextPage: number | null;
}

/**
 * Jobs as the tools see them (concept §5): submitting, status, page windows, cancellation, and the
 * deletion of expired uploads and jobs. Running them is the runner's business.
 */
export class JobService {
    readonly #store: Store;
    readonly #uploads: UploadService;
    readonly #limits: LimitsConfig;
    readonly #retentionMs: number;
    readonly #loggers: Loggers;
    readonly #wake: () => void;

    constructor(options: {
        store: Store;
        uploads: UploadService;
        limits: LimitsConfig;
        retentionMs: number;
        loggers: Loggers;
        /** Tells the local runner that the queue changed. */
        wake: () => void;
    }) {
        this.#store = options.store;
        this.#uploads = options.uploads;
        this.#limits = options.limits;
        this.#retentionMs = options.retentionMs;
        this.#loggers = options.loggers;
        this.#wake = options.wake;
    }

    async submit(caller: Caller, request: SubmitRequest): Promise<JobRecord> {
        if (request.language !== undefined && !LANGUAGE.test(request.language)) {
            throw new LoupeError('invalid_argument', `Invalid language '${request.language}'; expected a BCP 47 tag`);
        }
        if (request.pages !== undefined) parsePageSelection(request.pages);
        const upload: UploadRecord = await this.#uploads.get(request.uploadId);
        const now = Date.now();
        if (Date.parse(upload.expiresAt) < now + this.#limits.maxJobDurationMs) {
            throw new LoupeError(
                'expired',
                `Upload '${upload.uploadId}' expires before a job could finish; upload the files anew`
            );
        }
        const files = this.#pick(await this.#uploads.files(upload.uploadId), request.files);

        const jobId = newId('job');
        const createdAt = new Date(now).toISOString();
        const job: JobRecord = {
            jobId,
            uploadId: upload.uploadId,
            quality: request.quality,
            ...(request.language ? { language: request.language } : {}),
            ...(request.pages ? { pages: request.pages.replace(/\s+/g, '') } : {}),
            createdAt,
            expiresAt: new Date(now + this.#retentionMs).toISOString(),
            createdBy: caller.oid,
            queueEntry: paths.queueEntry(createdAt, jobId),
            files,
        };
        const state: JobState = {
            jobId,
            status: 'queued',
            updatedAt: createdAt,
            documents: files.map(() => ({ status: 'queued' })),
        };
        await putJson(this.#store, paths.job(jobId), job);
        await putJson(this.#store, paths.state(jobId), state);
        await putJson(this.#store, paths.manifest(jobId), manifestOf(job, state));
        await this.#store.put(job.queueEntry, jobId, 'text/plain');
        this.#wake();
        return job;
    }

    #pick(accepted: UploadedFile[], names: string[] | undefined): UploadedFile[] {
        if (accepted.length === 0) throw new LoupeError('invalid_argument', 'The upload holds no files yet');
        if (!names) return accepted;
        const byName = new Map(accepted.map((file) => [file.name, file]));
        const missing = names.filter((name) => !byName.has(name));
        if (missing.length > 0) {
            throw new LoupeError('not_found', `The upload has no file ${missing.map((n) => `'${n}'`).join(', ')}`);
        }
        const unique = [...new Set(names)];
        if (unique.length === 0) throw new LoupeError('invalid_argument', 'files is empty');
        return unique.map((name) => byName.get(name) as UploadedFile);
    }

    /** The job as stored; `not_found` for an unknown job or one already deleted after its retention. */
    async snapshot(jobId: string): Promise<JobSnapshot> {
        if (!isId('job', jobId)) throw new LoupeError('not_found', `Unknown job '${jobId}'`);
        const [job, state] = await Promise.all([
            getJson<JobRecord>(this.#store, paths.job(jobId)),
            getJson<JobState>(this.#store, paths.state(jobId)),
        ]);
        if (!job || !state) throw new LoupeError('not_found', `Unknown job '${jobId}'`);
        return { job, state, status: jobStatusOf(job, state) };
    }

    /** The job once its status or progress changed, or after `waitMs`. */
    async wait(jobId: string, waitMs: number): Promise<JobSnapshot> {
        const first = await this.snapshot(jobId);
        const deadline = Date.now() + Math.min(waitMs, MAX_WAIT_MS);
        let current = first;
        while (!isFinalJobStatus(current.status) && Date.now() < deadline) {
            await sleep(Math.min(WAIT_POLL_MS, Math.max(deadline - Date.now(), 0)));
            current = await this.snapshot(jobId);
            if (current.state.updatedAt !== first.state.updatedAt) break;
        }
        return current;
    }

    /** Asks the lease holder to stop the job, and waits a little for it to do so. */
    async cancel(jobId: string, caller: Caller): Promise<JobSnapshot> {
        const snapshot = await this.snapshot(jobId);
        if (isFinalJobStatus(snapshot.status)) return snapshot;
        await putJson(this.#store, paths.cancel(jobId), { requestedAt: new Date().toISOString(), by: caller.oid });
        this.#wake();
        const deadline = Date.now() + CANCEL_WAIT_MS;
        let current = snapshot;
        while (!isFinalJobStatus(current.status) && Date.now() < deadline) {
            await sleep(WAIT_POLL_MS);
            current = await this.snapshot(jobId);
        }
        return current;
    }

    /** A window of whole pages of one document's result, as many as fit into the byte limit (concept §5.4). */
    async readWindow(
        jobId: string,
        name: string,
        pageStart: number | undefined,
        pageCount: number | undefined
    ): Promise<PageWindow> {
        const { job, state, status } = await this.snapshot(jobId);
        if (status === 'expired') throw new LoupeError('expired', `Job '${jobId}' expired`);
        const index = job.files.findIndex((file) => file.name === name);
        const document = state.documents[index];
        if (index < 0 || !document) throw new LoupeError('not_found', `The job has no document '${name}'`);
        if (document.status !== 'succeeded' || !document.pages || !document.format) {
            throw new LoupeError(
                'not_found',
                `Document '${name}' is ${document.status}; it is readable once it succeeded`
            );
        }
        const all = document.pages;
        const first = pageStart === undefined ? 0 : all.findIndex((page) => page.number >= pageStart);
        const maxBytes = this.#limits.readMaxBytes;
        const selected: typeof all = [];
        let bytes = 0;
        for (let i = Math.max(first, 0); first >= 0 && i < all.length; i++) {
            const page = all[i] as (typeof all)[number];
            if (pageCount !== undefined && selected.length >= pageCount) break;
            if (selected.length > 0 && bytes + page.byteLength > maxBytes) break;
            selected.push(page);
            bytes += page.byteLength;
        }
        const window: PageWindow = {
            document: name,
            format: document.format,
            pageCount: all.length,
            pages: [],
            nextPage: null,
        };
        const lastSelected = selected.at(-1);
        if (!lastSelected) return window;
        const firstPage = selected[0] as (typeof all)[number];
        const length = Math.min(lastSelected.byteOffset + lastSelected.byteLength - firstPage.byteOffset, maxBytes);
        const data = await this.#store.getRange(
            paths.result(jobId, index, document.format === 'markdown' ? 'md' : 'html'),
            firstPage.byteOffset,
            length
        );
        for (const page of selected) {
            const start = page.byteOffset - firstPage.byteOffset;
            const element = data.subarray(start, start + page.byteLength);
            const truncated = element.length < page.byteLength;
            // a page cut at the limit may end inside a character; the decoder drops the partial one
            const content = new TextDecoder('utf-8', { fatal: false }).decode(element).replace(/�$/, '');
            window.pages.push({
                number: page.number,
                method: page.method,
                content: truncated ? content.replace(/^<page number="\d+">\n/, '') : pageContent(content),
                ...(truncated ? { truncated: true as const } : {}),
            });
        }
        window.nextPage = all[all.indexOf(lastSelected) + 1]?.number ?? null;
        return window;
    }

    /** Deletes uploads and jobs whose retention has passed (concept §6.4). */
    async sweep(): Promise<void> {
        const now = Date.now();
        for await (const { path } of this.#store.list(paths.uploads)) {
            if (!path.endsWith('/upload.json')) continue;
            const record = await getJson<UploadRecord>(this.#store, path);
            if (record && now > Date.parse(record.expiresAt)) {
                await this.#store.deletePrefix(paths.uploadPrefix(record.uploadId));
                this.#loggers.log.info({ uploadId: record.uploadId }, 'expired upload deleted');
            }
        }
        for await (const { path } of this.#store.list(paths.jobs)) {
            if (!path.endsWith('/job.json')) continue;
            const job = await getJson<JobRecord>(this.#store, path);
            if (job && now > Date.parse(job.expiresAt)) {
                await this.#store.delete(job.queueEntry).catch(() => undefined);
                await this.#store.deletePrefix(paths.jobPrefix(job.jobId));
                this.#loggers.log.info({ jobId: job.jobId }, 'expired job deleted');
            }
        }
        for await (const { path } of this.#store.list(paths.queue)) {
            if (!(await this.#store.head(paths.job(jobIdOfQueueEntry(path)))))
                await this.#store.delete(path).catch(() => undefined);
        }
    }
}
