import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LoupeError } from '../../src/core/errors.ts';
import type { ReadRequest, ReadResult } from '../../src/reading/types.ts';
import { AzureBlobStore } from '../../src/store/azureblob.ts';
import { type Azurite, startAzurite } from '../helpers/azurite.ts';
import { body, createJobsHarness } from '../helpers/jobs.ts';
import { makePdf } from '../helpers/pdf.ts';

const collect = async (iterable: AsyncIterable<{ path: string }>): Promise<string[]> => {
    const out: string[] = [];
    for await (const item of iterable) out.push(item.path);
    return out;
};

describe('azure blob store', () => {
    let azurite: Azurite;
    let store: AzureBlobStore;

    before(async () => {
        azurite = await startAzurite();
        store = new AzureBlobStore({
            connectionString: azurite.connectionString,
            container: await azurite.createContainer(),
        });
    });
    after(() => azurite.container.stop());

    it('writes, reads, ranges, lists and deletes', async () => {
        await store.put('a/1.json', '{"x":1}', 'application/json');
        await store.put('a/b/2.txt', 'hello world', 'text/plain');
        await store.put('c/3.txt', 'other', 'text/plain');
        const listed: { path: string; size: number }[] = [];
        for await (const item of store.list('a/')) listed.push(item);
        assert.deepEqual(listed, [
            { path: 'a/1.json', size: 7 },
            { path: 'a/b/2.txt', size: 11 },
        ]);
        assert.equal((await store.get('a/1.json'))?.toString(), '{"x":1}');
        assert.equal((await store.getRange('a/b/2.txt', 6, 5)).toString(), 'world');
        assert.equal((await store.head('a/b/2.txt'))?.size, 11);
        assert.equal(await store.get('missing'), undefined);
        assert.deepEqual(await collect(store.list('a/')), ['a/1.json', 'a/b/2.txt']);
        await store.deletePrefix('a/');
        assert.deepEqual(await collect(store.list('a/')), []);
        await store.delete('missing');
    });

    it('creates write-once objects, and nothing when the body fails', async () => {
        await store.create('once', Readable.from([Buffer.from('first')]), 'application/octet-stream');
        await assert.rejects(
            store.create('once', Readable.from([Buffer.from('second')]), 'application/octet-stream'),
            (error: unknown) => error instanceof LoupeError && error.code === 'conflict'
        );
        assert.equal((await store.get('once'))?.toString(), 'first');

        const results = await Promise.allSettled(
            ['a', 'b', 'c'].map((value) => store.create('race', Readable.from([Buffer.alloc(5_000_000, value)]), 'x'))
        );
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);

        const failing = new Readable({
            read() {
                this.push(Buffer.alloc(5_000_000));
                this.destroy(new Error('client went away'));
            },
        });
        await assert.rejects(store.create('broken', failing, 'x'), /client went away/);
        assert.equal(await store.head('broken'), undefined);
    });

    it('leases objects to one holder at a time', async () => {
        await store.put('queue/1-j_x', 'j_x', 'text/plain');
        const lease = await store.acquireLease('queue/1-j_x', 15);
        assert.ok(lease);
        assert.equal(await store.acquireLease('queue/1-j_x', 15), undefined);
        assert.equal(await store.renewLease('queue/1-j_x', lease), true);
        assert.equal(await store.renewLease('queue/1-j_x', '00000000-0000-0000-0000-000000000000'), false);
        await store.releaseLease('queue/1-j_x', lease);
        const second = await store.acquireLease('queue/1-j_x', 15);
        assert.ok(second);
        await assert.rejects(store.delete('queue/1-j_x'));
        await store.deleteLeased('queue/1-j_x', second);
        assert.equal(await store.head('queue/1-j_x'), undefined);
        assert.equal(await store.acquireLease('queue/1-j_x', 15), undefined);
    });

    it('runs a job across two replicas sharing the store', async () => {
        const slow = {
            read: async (request: ReadRequest): Promise<ReadResult> => {
                if (request.name !== 'a.pdf') await delay(60_000, undefined, { signal: request.signal });
                return { format: 'markdown', pages: [{ number: 1, method: 'layout', content: request.name }] };
            },
        };
        const shared = new AzureBlobStore({
            connectionString: azurite.connectionString,
            container: await azurite.createContainer(),
        });
        const harness = await createJobsHarness(slow, { store: shared, limits: { analysisConcurrency: 1 } });
        try {
            const { uploadId } = await harness.uploads.create({ oid: 'user-1' });
            for (const name of ['a.pdf', 'b.pdf', 'c.pdf'])
                await harness.uploads.put(uploadId, name, body(makePdf([name])), undefined);
            const job = await harness.jobs.submit(
                { oid: 'user-1' },
                { uploadId, quality: 'fast', files: undefined, language: undefined, pages: undefined }
            );

            const first = harness.runner;
            first.start();
            // a started document shows as running with the next state write, at most 5 s later
            for (
                let i = 0;
                i < 300 && (await harness.jobs.snapshot(job.jobId)).state.documents[1]?.status !== 'running';
                i++
            ) {
                await delay(50);
            }
            // the second replica polls too, but the lease keeps the job with the first one
            const second = harness.replica({
                read: async (request) => ({
                    format: 'markdown',
                    pages: [{ number: 1, method: 'layout', content: `second ${request.name}` }],
                }),
            });
            second.start();
            await delay(500);
            assert.deepEqual(
                (await harness.jobs.snapshot(job.jobId)).state.documents.map((d) => d.status),
                ['succeeded', 'running', 'queued']
            );
            await first.shutdown();
            for (let i = 0; i < 200 && (await harness.jobs.snapshot(job.jobId)).status !== 'completed'; i++)
                await delay(50);
            const done = await harness.jobs.snapshot(job.jobId);
            assert.equal(done.status, 'completed');
            const window = await harness.jobs.readWindow(job.jobId, 'b.pdf', undefined, undefined);
            assert.equal(window.pages[0]?.content, 'second b.pdf');
            assert.equal(
                (await harness.jobs.readWindow(job.jobId, 'a.pdf', undefined, undefined)).pages[0]?.content,
                'a.pdf'
            );
            assert.deepEqual(await collect(shared.list('queue/')), []);
        } finally {
            await harness.dispose();
        }
    });
});
