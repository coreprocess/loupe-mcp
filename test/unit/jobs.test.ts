import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LoupeError } from '../../src/core/errors.ts';
import type { Caller } from '../../src/jobs/model.ts';
import { DocumentError } from '../../src/reading/errors.ts';
import type { ReadRequest, ReadResult } from '../../src/reading/types.ts';
import { paths } from '../../src/store/paths.ts';
import { getJson } from '../../src/store/store.ts';
import { DOCUMENT_TYPES } from '../../src/uploads/types.ts';
import { body, createJobsHarness, type JobsHarness } from '../helpers/jobs.ts';
import { makePdf } from '../helpers/pdf.ts';

const caller: Caller = { oid: 'user-1', name: 'ada@example.com' };
const PDF = makePdf(['page']);

const pagesOf = (name: string, count = 2): ReadResult => ({
    format: 'html',
    pages: Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        method: 'vision',
        content: `<p>${name} ${i + 1}</p>`,
    })),
});

/** A reader that answers at once, or after the given time, and records the order of documents. */
const fakeReader = (options: { delayMs?: number; fail?: (name: string) => Error | undefined } = {}) => {
    const order: string[] = [];
    return {
        order,
        read: async (request: ReadRequest): Promise<ReadResult> => {
            order.push(request.name);
            request.progress(1, 2);
            if (options.delayMs) await delay(options.delayMs, undefined, { signal: request.signal });
            const failure = options.fail?.(request.name);
            if (failure) throw failure;
            return pagesOf(request.name);
        },
    };
};

const isCode = (code: string) => (error: unknown) => error instanceof LoupeError && error.code === code;

const until = async (check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await delay(20);
    }
};

const finished = (harness: JobsHarness, jobId: string) => async () =>
    ['completed', 'cancelled'].includes((await harness.jobs.snapshot(jobId)).status);

describe('uploads', () => {
    let harness: JobsHarness;
    afterEach(() => harness.dispose());

    it('accepts write-once files of accepted types within the limits', async () => {
        harness = await createJobsHarness(fakeReader(), { limits: { uploadMaxFiles: 2, maxFileBytes: 5000 } });
        const { uploadId } = await harness.uploads.create(caller);
        const file = await harness.uploads.put(uploadId, 'a.pdf', body(PDF), PDF.length);
        assert.equal(file.type, DOCUMENT_TYPES.pdf);
        assert.equal(file.bytes, PDF.length);
        await assert.rejects(harness.uploads.put(uploadId, 'a.pdf', body(PDF), undefined), isCode('conflict'));
        await assert.rejects(
            harness.uploads.put(uploadId, 'b.txt', body('plain text'), undefined),
            isCode('unsupported_type')
        );
        await assert.rejects(
            harness.uploads.put(uploadId, 'big.pdf', body(Buffer.alloc(6000)), undefined),
            isCode('too_large')
        );
        await assert.rejects(harness.uploads.put(uploadId, 'big.pdf', body('x'), 6000), isCode('too_large'));
        // refused files leave nothing behind: the names stay free
        await harness.uploads.put(uploadId, 'b.txt', body(PDF), undefined);
        await assert.rejects(harness.uploads.put(uploadId, 'c.pdf', body(PDF), undefined), isCode('limit_exceeded'));
        assert.deepEqual(
            (await harness.uploads.files(uploadId)).map((f) => f.name),
            ['a.pdf', 'b.txt']
        );
    });

    it('lets exactly one of two concurrent uploads of a name succeed', async () => {
        harness = await createJobsHarness(fakeReader());
        const { uploadId } = await harness.uploads.create(caller);
        const results = await Promise.allSettled([
            harness.uploads.put(uploadId, 'same.pdf', body(PDF), undefined),
            harness.uploads.put(uploadId, 'same.pdf', body(PDF), undefined),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal((await harness.uploads.files(uploadId)).length, 1);
    });

    it('refuses unknown and expired uploads', async () => {
        harness = await createJobsHarness(fakeReader(), { retentionMs: 1 });
        await assert.rejects(harness.uploads.get('u_unknown'), isCode('not_found'));
        const { uploadId } = await harness.uploads.create(caller);
        await delay(5);
        await assert.rejects(harness.uploads.put(uploadId, 'a.pdf', body(PDF), undefined), isCode('expired'));
    });
});

describe('jobs', () => {
    let harness: JobsHarness;
    afterEach(() => harness.dispose());

    const uploadWith = async (names: string[]) => {
        const { uploadId } = await harness.uploads.create(caller);
        for (const name of names) await harness.uploads.put(uploadId, name, body(PDF), undefined);
        return uploadId;
    };
    const submit = (uploadId: string, extra: Partial<Parameters<JobsHarness['jobs']['submit']>[1]> = {}) =>
        harness.jobs.submit(caller, {
            uploadId,
            quality: 'fast',
            files: undefined,
            language: undefined,
            pages: undefined,
            ...extra,
        });

    it('validates a submit before it creates a job', async () => {
        harness = await createJobsHarness(fakeReader());
        const empty = (await harness.uploads.create(caller)).uploadId;
        await assert.rejects(submit(empty), isCode('invalid_argument'));
        const uploadId = await uploadWith(['a.pdf']);
        await assert.rejects(submit(uploadId, { files: ['missing.pdf'] }), isCode('not_found'));
        await assert.rejects(submit(uploadId, { language: 'not a tag' }), isCode('invalid_argument'));
        await assert.rejects(submit(uploadId, { pages: '3-1' }), isCode('invalid_argument'));
        await assert.rejects(submit('u_unknown'), isCode('not_found'));
        let queued = 0;
        for await (const _ of harness.store.list(paths.queue)) queued++;
        assert.equal(queued, 0);
    });

    it('refuses an upload that would expire before the job could finish', async () => {
        harness = await createJobsHarness(fakeReader(), {
            retentionMs: 3_600_000 * 2,
            limits: { maxJobDurationMs: 3_600_000 * 3 },
        });
        await assert.rejects(submit(await uploadWith(['a.pdf'])), isCode('expired'));
    });

    it('reads every document, writes results with a page index, and pages through them', async () => {
        harness = await createJobsHarness(fakeReader(), { limits: { readMaxBytes: 1024 } });
        harness.runner.start();
        const uploadId = await uploadWith(['a.pdf', 'b.pdf']);
        const job = await submit(uploadId, { files: ['b.pdf'], quality: 'accurate', language: 'de', pages: '1-2' });
        await until(finished(harness, job.jobId));
        const { state, status } = await harness.jobs.snapshot(job.jobId);
        assert.equal(status, 'completed');
        assert.equal(state.documents.length, 1);
        assert.equal(state.documents[0]?.status, 'succeeded');
        assert.equal(state.documents[0]?.pages?.length, 2);

        const window = await harness.jobs.readWindow(job.jobId, 'b.pdf', undefined, 1);
        assert.deepEqual(window.pages, [{ number: 1, method: 'vision', content: '<p>b.pdf 1</p>' }]);
        assert.equal(window.nextPage, 2);
        const rest = await harness.jobs.readWindow(job.jobId, 'b.pdf', 2, undefined);
        assert.deepEqual(
            rest.pages.map((page) => page.content),
            ['<p>b.pdf 2</p>']
        );
        assert.equal(rest.nextPage, null);
        await assert.rejects(harness.jobs.readWindow(job.jobId, 'a.pdf', undefined, undefined), isCode('not_found'));

        const manifest = await getJson<Record<string, unknown>>(harness.store, paths.manifest(job.jobId));
        assert.equal(manifest?.status, 'completed');
        let queued = 0;
        for await (const _ of harness.store.list(paths.queue)) queued++;
        assert.equal(queued, 0);
    });

    it('cuts a page larger than a window and marks it truncated', async () => {
        const reader = {
            read: async (): Promise<ReadResult> => ({
                format: 'markdown',
                pages: [{ number: 1, method: 'layout', content: 'ü'.repeat(3000) }],
            }),
        };
        harness = await createJobsHarness(reader, { limits: { readMaxBytes: 1024 } });
        harness.runner.start();
        const job = await submit(await uploadWith(['a.pdf']));
        await until(finished(harness, job.jobId));
        const window = await harness.jobs.readWindow(job.jobId, 'a.pdf', undefined, undefined);
        assert.equal(window.pages[0]?.truncated, true);
        assert.ok(!window.pages[0]?.content.includes('�'));
        assert.ok(Buffer.byteLength(window.pages[0]?.content ?? '') <= 1024);
    });

    it('records failures per document', async () => {
        harness = await createJobsHarness(
            fakeReader({
                fail: (name) =>
                    name === 'bad.pdf'
                        ? new DocumentError('unreadable', 'The file is damaged')
                        : name === 'bug.pdf'
                          ? new Error('unexpected')
                          : undefined,
            })
        );
        harness.runner.start();
        const job = await submit(await uploadWith(['ok.pdf', 'bad.pdf', 'bug.pdf']));
        await until(finished(harness, job.jobId));
        const { state, status } = await harness.jobs.snapshot(job.jobId);
        assert.equal(status, 'completed');
        assert.deepEqual(
            state.documents.map((d) => [d.status, d.error?.code]),
            [
                ['succeeded', undefined],
                ['failed', 'unreadable'],
                ['failed', 'internal'],
            ]
        );
    });

    it('cancels a running job; documents already read stay', async () => {
        const reader = fakeReader({ delayMs: 60_000 });
        harness = await createJobsHarness(
            {
                read: (request) =>
                    request.name === 'fast.pdf' ? Promise.resolve(pagesOf('fast.pdf')) : reader.read(request),
            },
            { limits: { analysisConcurrency: 1 } }
        );
        harness.runner.start();
        const job = await submit(await uploadWith(['fast.pdf', 'slow.pdf', 'never.pdf']));
        await until(async () => (await harness.jobs.snapshot(job.jobId)).state.documents[1]?.status === 'running');
        const snapshot = await harness.jobs.cancel(job.jobId, caller);
        assert.equal(snapshot.status, 'cancelled');
        assert.deepEqual(
            snapshot.state.documents.map((d) => d.status),
            ['succeeded', 'cancelled', 'cancelled']
        );
        assert.equal((await harness.jobs.readWindow(job.jobId, 'fast.pdf', undefined, undefined)).pages.length, 2);
    });

    it('takes jobs in turn, so a small job is not held back by a large one', async () => {
        const reader = fakeReader({ delayMs: 30 });
        harness = await createJobsHarness(reader, { limits: { analysisConcurrency: 1 } });
        const large = await submit(await uploadWith(['l1.pdf', 'l2.pdf', 'l3.pdf', 'l4.pdf', 'l5.pdf']));
        const small = await submit(await uploadWith(['s1.pdf']));
        harness.runner.start();
        await until(finished(harness, small.jobId));
        await until(finished(harness, large.jobId));
        assert.ok(reader.order.indexOf('s1.pdf') <= 2, reader.order.join(','));
    });

    it('fails what is open when the job reaches its maximum duration', async () => {
        harness = await createJobsHarness(fakeReader({ delayMs: 60_000 }), {
            limits: { maxJobDurationMs: 300, analysisConcurrency: 1 },
        });
        harness.runner.start();
        const job = await submit(await uploadWith(['a.pdf', 'b.pdf']));
        await until(finished(harness, job.jobId), 15_000);
        const { state } = await harness.jobs.snapshot(job.jobId);
        assert.deepEqual(
            state.documents.map((d) => [d.status, d.error?.code]),
            [
                ['failed', 'timeout'],
                ['failed', 'timeout'],
            ]
        );
    });

    it('continues a job on another replica after a shutdown, keeping what succeeded', async () => {
        const first = fakeReader({ delayMs: 60_000 });
        harness = await createJobsHarness(
            { read: (request) => (request.name === 'a.pdf' ? Promise.resolve(pagesOf('a.pdf')) : first.read(request)) },
            { limits: { analysisConcurrency: 1 } }
        );
        harness.runner.start();
        const job = await submit(await uploadWith(['a.pdf', 'b.pdf', 'c.pdf']));
        await until(async () => (await harness.jobs.snapshot(job.jobId)).state.documents[1]?.status === 'running');
        await harness.runner.shutdown();
        const stopped = await harness.jobs.snapshot(job.jobId);
        assert.deepEqual(
            stopped.state.documents.map((d) => d.status),
            ['succeeded', 'queued', 'queued']
        );

        const second = fakeReader();
        harness.replica(second).start();
        await until(finished(harness, job.jobId));
        assert.deepEqual(second.order, ['b.pdf', 'c.pdf']);
        assert.equal((await harness.jobs.snapshot(job.jobId)).status, 'completed');
    });

    it('waits for a change and reports expired jobs; the sweep deletes them', async () => {
        harness = await createJobsHarness(fakeReader({ delayMs: 100 }), {
            retentionMs: 1500,
            limits: { maxJobDurationMs: 100 },
        });
        const job = await submit(await uploadWith(['a.pdf']));
        harness.runner.start();
        const started = Date.now();
        const changed = await harness.jobs.wait(job.jobId, 5000);
        assert.ok(Date.now() - started < 4000);
        assert.notEqual(changed.state.updatedAt, job.createdAt);
        await until(finished(harness, job.jobId));
        await delay(1600);
        assert.equal((await harness.jobs.snapshot(job.jobId)).status, 'expired');
        await harness.jobs.sweep();
        await assert.rejects(harness.jobs.snapshot(job.jobId), isCode('not_found'));
        await assert.rejects(harness.uploads.get(job.uploadId), isCode('not_found'));
    });
});
