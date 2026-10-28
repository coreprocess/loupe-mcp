import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../../src/config/env.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { Signer } from '../../src/core/signing.ts';
import type { ReadResult } from '../../src/reading/types.ts';
import { createHttpApp } from '../../src/server/http.ts';
import type { ToolContext } from '../../src/tools/tools.ts';
import { createJobsHarness, type JobsHarness } from '../helpers/jobs.ts';
import { makePdf } from '../helpers/pdf.ts';

const PDF = makePdf(['page']);

const reader = {
    read: async (): Promise<ReadResult> => ({
        format: 'html',
        pages: [
            { number: 1, method: 'vision', content: '<p>One</p>' },
            { number: 2, method: 'layout', content: '<p>Two</p>' },
        ],
    }),
};

const text = (result: unknown): Record<string, unknown> => {
    const content = (result as { content: { type: string; text?: string }[] }).content;
    return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}') as Record<string, unknown>;
};

/** Raw request, so the Host and Origin headers can be set like a DNS-rebinding page would send them. */
const status = (port: number, headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/healthz', headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        })
            .on('error', reject)
            .end();
    });

describe('http app (data plane and tools, without authorization on localhost)', () => {
    let harness: JobsHarness;
    let server: Server;
    let port: number;
    let base: string;
    let client: Client;
    let signer: Signer;

    const call = async (name: string, args: Record<string, unknown>) =>
        text(await client.callTool({ name, arguments: args }));

    before(async () => {
        harness = await createJobsHarness(reader);
        harness.runner.start();
        const config = loadConfig({
            LOUPE_TRANSPORT: 'http',
            LOUPE_HOST: '127.0.0.1',
            LOUPE_PORT: '0',
            LOUPE_AUTH: 'none',
            LOUPE_STORE: 'filesystem',
            LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'http://127.0.0.1:9',
            LOUPE_OPENAI_ENDPOINT: 'http://127.0.0.1:9',
        });
        const loggers = nullLoggers();
        signer = new Signer(config.signingKey);
        const context: ToolContext = {
            config,
            uploads: harness.uploads,
            jobs: harness.jobs,
            signer,
            loggers,
            publicUrl: () => base,
        };
        const app = createHttpApp(
            config,
            context,
            { store: harness.store, jobs: harness.jobs, uploads: harness.uploads, signer, loggers },
            { mcp: true }
        );
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        port = (server.address() as AddressInfo).port;
        base = `http://127.0.0.1:${port}`;
        client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    });

    after(async () => {
        await client.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await harness.dispose();
    });

    it('rejects DNS rebinding and cross-site requests', async () => {
        assert.equal(await status(port, { host: `127.0.0.1:${port}` }), 200);
        assert.equal(await status(port, { host: `rebind.example.com:${port}` }), 403);
        assert.equal(await status(port, { host: `127.0.0.1:${port}`, origin: 'https://evil.example.com' }), 403);
    });

    it('uploads, submits, reports, reads and serves a job end to end', async () => {
        const upload = await call('create_upload', {});
        const uploadUrl = upload.uploadUrl as string;
        assert.match(uploadUrl, /\/u\/[^/]+\/$/);
        assert.deepEqual((upload.limits as { types: string[] }).types.includes('application/pdf'), true);

        const put = (name: string, data: Buffer | string, url = uploadUrl) =>
            fetch(`${url}${encodeURIComponent(name)}`, { method: 'PUT', body: data });
        const created = await put('Scan Müller 01.pdf', PDF);
        assert.equal(created.status, 201);
        assert.deepEqual(Object.keys((await created.json()) as object), ['name', 'bytes', 'sha256', 'type']);
        assert.equal((await put('Scan Müller 01.pdf', PDF)).status, 409);
        const unsupported = await put('notes.txt', 'just text');
        assert.equal(unsupported.status, 415);
        assert.equal(((await unsupported.json()) as { error: { code: string } }).error.code, 'unsupported_type');
        assert.equal((await fetch(`${uploadUrl}a%2Fb.pdf`, { method: 'PUT', body: PDF })).status, 400);
        assert.equal((await fetch(uploadUrl, { method: 'PUT', body: PDF })).status, 400);
        assert.equal((await fetch(`${uploadUrl}x.pdf`)).status, 405);
        const forged = uploadUrl.replace(
            /\/u\/[^/]+\//,
            `/u/${signer.sign('upload', { id: upload.uploadId as string, user: 'u', expires: 1 })}/`
        );
        assert.equal((await put('late.pdf', PDF, forged)).status, 403);
        const wrongPurpose = `${base}/u/${signer.sign('download', { id: upload.uploadId as string, user: 'u', expires: 2e9 })}/`;
        assert.equal((await put('other.pdf', PDF, wrongPurpose)).status, 403);

        const renewed = await call('create_upload', { uploadId: upload.uploadId });
        assert.equal(renewed.uploadId, upload.uploadId);

        const submitted = await call('submit', { uploadId: upload.uploadId, quality: 'accurate' });
        const jobId = submitted.jobId as string;
        let job = await call('get_job', { jobId, wait: 10 });
        for (let i = 0; i < 20 && job.status !== 'completed'; i++) job = await call('get_job', { jobId, wait: 10 });
        assert.equal(job.status, 'completed');
        assert.deepEqual(job.progress, { documents: 1, succeeded: 1, failed: 0, cancelled: 0, pages: 2, pagesDone: 2 });
        assert.deepEqual((job.documents as Record<string, unknown>[])[0], {
            name: 'Scan Müller 01.pdf',
            status: 'succeeded',
            type: 'application/pdf',
            pages: 2,
            methods: { vision: 1, layout: 1 },
            bytes: 76,
        });

        const window = await call('read_result', { jobId, document: 'Scan Müller 01.pdf', pageStart: 2 });
        assert.deepEqual(window.pages, [{ number: 2, method: 'layout', content: '<p>Two</p>' }]);

        const manifestUrl = (job.download as { manifestUrl: string }).manifestUrl;
        const manifest = (await (await fetch(manifestUrl)).json()) as {
            documents: { path: string; pages: { byteOffset: number; byteLength: number }[] }[];
        };
        const document = manifest.documents[0];
        assert.ok(document);
        const root = manifestUrl.slice(0, -'manifest.json'.length);
        assert.equal(document.path, 'documents/Scan%20M%C3%BCller%2001.pdf.html');
        const full = await fetch(`${root}${document.path}`);
        assert.equal(full.status, 200);
        assert.equal(full.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.equal(full.headers.get('content-security-policy'), 'sandbox');
        assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(full.headers.get('cache-control'), 'private, no-store, no-transform');
        assert.equal(
            await full.text(),
            '<page number="1">\n<p>One</p>\n</page>\n\n<page number="2">\n<p>Two</p>\n</page>\n\n'
        );
        const second = document.pages[1];
        assert.ok(second);
        const ranged = await fetch(`${root}${document.path}`, {
            headers: { range: `bytes=${second.byteOffset}-${second.byteOffset + second.byteLength - 1}` },
        });
        assert.equal(ranged.status, 206);
        assert.equal(await ranged.text(), '<page number="2">\n<p>Two</p>\n</page>\n\n');
        const etag = full.headers.get('etag') ?? '';
        assert.equal((await fetch(`${root}${document.path}`, { headers: { 'if-none-match': etag } })).status, 304);
        assert.equal((await fetch(`${root}${document.path}`, { headers: { range: 'bytes=9999-' } })).status, 416);
        assert.equal((await fetch(`${root}${document.path}`, { method: 'HEAD' })).headers.get('content-length'), '76');

        for (const internal of [
            'state.json',
            'job.json',
            'cancel.json',
            'documents/0.html',
            '../job.json',
            'documents/Scan%20M%C3%BCller%2001.pdf.md',
        ]) {
            assert.equal((await fetch(`${root}${internal}`)).status, 404, internal);
        }
        const uploadToken = `${base}/r/${signer.sign('upload', { id: jobId, user: 'u', expires: 2e9 })}/manifest.json`;
        assert.equal((await fetch(uploadToken)).status, 403);

        const cancelled = await call('cancel_job', { jobId });
        assert.equal(cancelled.status, 'completed');
    });

    it('refuses an oversized upload at once and closes the connection', async () => {
        const upload = await call('create_upload', {});
        const url = new URL(`${upload.uploadUrl}huge.pdf`);
        const answer = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
            const req = request(
                {
                    host: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'PUT',
                    headers: { 'content-length': String(64 * 1024 * 1024) },
                },
                (res) => {
                    res.resume();
                    resolve({ status: res.statusCode ?? 0, connection: res.headers.connection });
                }
            );
            req.on('error', reject);
            // only the first bytes of the declared body are ever sent
            req.write(Buffer.alloc(1024));
        });
        assert.deepEqual(answer, { status: 413, connection: 'close' });
    });

    it('reports tool errors with stable codes', async () => {
        const missing = await client.callTool({ name: 'get_job', arguments: { jobId: 'j_unknown' } });
        assert.equal(missing.isError, true);
        assert.equal((text(missing).error as { code: string }).code, 'not_found');
        const invalid = await client.callTool({ name: 'submit', arguments: { uploadId: 'u_x', quality: 'best' } });
        assert.equal(invalid.isError, true);
    });
});
