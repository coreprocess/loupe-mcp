import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { type Azurite, startAzurite } from '../helpers/azurite.ts';
import { MockServices } from '../helpers/mock-services.ts';
import { makePdf } from '../helpers/pdf.ts';

const run = promisify(execFile);

const TENANT = '11111111-2222-3333-4444-555555555555';
const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SIGNING_KEY = 'e2e-signing-key-that-is-long-enough-123';

const freePort = (): Promise<number> =>
    new Promise((resolve) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            server.close(() => resolve(port));
        });
    });

const text = (result: unknown): Record<string, unknown> => {
    const content = (result as { content: { type: string; text?: string }[] }).content;
    return JSON.parse(content.find((c) => c.type === 'text')?.text ?? '{}') as Record<string, unknown>;
};

describe('end to end (two http replicas on Azurite, Entra auth, curl; stdio)', () => {
    let azurite: Azurite;
    let mock: MockServices;
    let jwks: Server;
    let privateKey: CryptoKey;
    let dir: string;
    let storeEnv: Record<string, string>;
    const replicas: { process: ChildProcess; base: string }[] = [];

    const mint = (claims: Record<string, unknown> = {}): Promise<string> =>
        new SignJWT({
            scp: 'Loupe.Access',
            roles: ['Loupe.User'],
            tid: TENANT,
            oid: 'user-1',
            preferred_username: 'ada@example.com',
            ver: '2.0',
            ...claims,
        })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
            .setAudience(APP_ID)
            .setIssuedAt()
            .setExpirationTime('10m')
            .sign(privateKey);

    const connect = async (base: string): Promise<Client> => {
        const client = new Client({ name: 'e2e', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${await mint()}` } },
            })
        );
        return client;
    };

    const startReplica = async (name: string): Promise<{ process: ChildProcess; base: string }> => {
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        const child = spawn(process.execPath, ['src/index.ts'], {
            env: {
                PATH: process.env.PATH,
                ...storeEnv,
                LOUPE_TRANSPORT: 'http',
                LOUPE_HOST: '127.0.0.1',
                LOUPE_PORT: String(port),
                LOUPE_PUBLIC_URL: base,
                LOUPE_AUTH_TENANT_ID: TENANT,
                LOUPE_AUTH_CLIENT_ID: APP_ID,
                LOUPE_AUTH_JWKS_URI: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/keys`,
                LOUPE_SIGNING_KEY: SIGNING_KEY,
                LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT: mock.url,
                LOUPE_DOCUMENT_INTELLIGENCE_KEY: 'di-key',
                LOUPE_OPENAI_ENDPOINT: mock.url,
                LOUPE_OPENAI_KEY: 'openai-key',
                LOUPE_ANALYSIS_CONCURRENCY: '1',
                LOUPE_AUDIT_LOG: join(dir, `audit-${name}.log`),
                LOUPE_LOG_LEVEL: 'warn',
            },
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        for (let i = 0; i < 100; i++) {
            const ok = await fetch(`${base}/healthz`).then(
                (r) => r.ok,
                () => false
            );
            if (ok) break;
            await delay(200);
        }
        const replica = { process: child, base };
        replicas.push(replica);
        return replica;
    };

    before(async () => {
        azurite = await startAzurite();
        mock = new MockServices();
        await mock.start();
        const keys = await generateKeyPair('RS256', { extractable: true });
        privateKey = keys.privateKey;
        const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
        jwks = createServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
        await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
        dir = await mkdtemp(join(tmpdir(), 'loupe-e2e-'));
        storeEnv = {
            LOUPE_STORE: 'azureblob',
            LOUPE_STORE_CONNECTION_STRING: azurite.connectionString,
            LOUPE_STORE_CONTAINER: await azurite.createContainer(),
        };
    });

    after(async () => {
        for (const replica of replicas) replica.process.kill('SIGKILL');
        jwks?.close();
        await mock?.stop();
        await azurite?.container.stop();
        await rm(dir, { recursive: true, force: true });
    });

    it('publishes resource metadata and refuses callers without token or role', async () => {
        const { base } = await startReplica('a');
        const metadata = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
            string,
            unknown
        >;
        assert.deepEqual(metadata.scopes_supported, [`${base}/mcp/Loupe.Access`]);
        const unauthenticated = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(unauthenticated.status, 401);
        const noRole = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${await mint({ roles: [] })}`, 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(noRole.status, 403);
    });

    it('uploads with curl, reads at both levels, and downloads the results', async () => {
        const [a] = replicas;
        assert.ok(a);
        const client = await connect(a.base);
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
            'cancel_job',
            'create_upload',
            'get_job',
            'read_result',
            'submit',
        ]);

        const upload = text(await client.callTool({ name: 'create_upload', arguments: {} }));
        const files = join(dir, 'files');
        await run('mkdir', ['-p', files]);
        await writeFile(join(files, 'Vertrag Müller.pdf'), makePdf(['One', 'Two']));
        await writeFile(join(files, 'notes.txt'), 'plain text');
        const { stdout } = await run('curl', [
            '-fsS',
            '-T',
            join(files, 'Vertrag Müller.pdf'),
            upload.uploadUrl as string,
        ]);
        assert.equal((JSON.parse(stdout) as { name: string }).name, 'Vertrag Müller.pdf');
        await assert.rejects(run('curl', ['-fsS', '-T', join(files, 'notes.txt'), upload.uploadUrl as string]), /415/);

        for (const quality of ['fast', 'accurate']) {
            mock.reset();
            const { jobId } = text(
                await client.callTool({ name: 'submit', arguments: { uploadId: upload.uploadId, quality } })
            );
            let job: Record<string, unknown> = {};
            for (let i = 0; i < 30 && job.status !== 'completed'; i++) {
                job = text(await client.callTool({ name: 'get_job', arguments: { jobId, wait: 10 } }));
            }
            assert.equal(job.status, 'completed');
            const [document] = job.documents as { methods: Record<string, number> }[];
            assert.deepEqual(document?.methods, quality === 'fast' ? { layout: 2 } : { vision: 2 });
            const window = text(
                await client.callTool({ name: 'read_result', arguments: { jobId, document: 'Vertrag Müller.pdf' } })
            );
            assert.equal((window.pages as unknown[]).length, 2);

            const manifestUrl = (job.download as { manifestUrl: string }).manifestUrl;
            const out = join(dir, `download-${quality}`);
            await run('mkdir', ['-p', out]);
            const manifest = JSON.parse((await run('curl', ['-fsS', manifestUrl])).stdout) as {
                documents: { path: string; sha256: string }[];
            };
            const entry = manifest.documents[0];
            assert.ok(entry);
            await run('curl', [
                '-fsS',
                '-o',
                join(out, 'result'),
                `${manifestUrl.slice(0, -'manifest.json'.length)}${entry.path}`,
            ]);
            const result = await readFile(join(out, 'result'), 'utf8');
            assert.match(result, quality === 'fast' ? /OCR text of page 2/ : /Vision page 2/);
        }
        await client.close();
        const audit = await readFile(join(dir, 'audit-a.log'), 'utf8');
        assert.match(audit, /"event":"upload"/);
        assert.match(audit, /"event":"download"/);
        assert.doesNotMatch(audit, /Vision page|OCR text/);
    });

    it('continues a job on another replica after one is killed', { timeout: 180_000 }, async () => {
        const [a] = replicas;
        assert.ok(a);
        const b = await startReplica('b');
        mock.reset();
        mock.behavior.visionDelayMs = 1500;
        const client = await connect(a.base);
        const upload = text(await client.callTool({ name: 'create_upload', arguments: {} }));
        for (const name of ['1.pdf', '2.pdf', '3.pdf']) {
            const response = await fetch(`${upload.uploadUrl}${name}`, { method: 'PUT', body: makePdf([name]) });
            assert.equal(response.status, 201);
        }
        // replica b must not take the job first: it is stopped until a holds the lease
        b.process.kill('SIGSTOP');
        const { jobId } = text(
            await client.callTool({ name: 'submit', arguments: { uploadId: upload.uploadId, quality: 'accurate' } })
        );
        let job: Record<string, unknown> = {};
        for (let i = 0; i < 50; i++) {
            job = text(await client.callTool({ name: 'get_job', arguments: { jobId, wait: 2 } }));
            if ((job.progress as { succeeded: number }).succeeded >= 1) break;
        }
        assert.equal(job.status, 'running');
        a.process.kill('SIGKILL');
        b.process.kill('SIGCONT');

        const other = await connect(b.base);
        for (let i = 0; i < 20 && job.status !== 'completed'; i++) {
            job = text(await other.callTool({ name: 'get_job', arguments: { jobId, wait: 10 } }));
        }
        assert.equal(job.status, 'completed');
        assert.equal((job.progress as { succeeded: number }).succeeded, 3);
        await other.close();
    });

    it('runs in stdio mode with a local store and data plane', async () => {
        const client = new Client({ name: 'stdio', version: '1.0.0' });
        await client.connect(
            new StdioClientTransport({
                command: process.execPath,
                args: ['src/index.ts'],
                env: {
                    PATH: process.env.PATH ?? '',
                    LOUPE_STORE_DIR: join(dir, 'stdio'),
                    LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT: mock.url,
                    LOUPE_DOCUMENT_INTELLIGENCE_KEY: 'k',
                    LOUPE_OPENAI_ENDPOINT: mock.url,
                    LOUPE_OPENAI_KEY: 'k',
                    LOUPE_LOG_LEVEL: 'warn',
                },
                stderr: 'ignore',
            })
        );
        mock.reset();
        const upload = text(await client.callTool({ name: 'create_upload', arguments: {} }));
        assert.match(upload.uploadUrl as string, /^http:\/\/127\.0\.0\.1:\d+\/u\//);
        assert.equal((await fetch(`${upload.uploadUrl}a.pdf`, { method: 'PUT', body: makePdf(['x']) })).status, 201);
        const { jobId } = text(
            await client.callTool({ name: 'submit', arguments: { uploadId: upload.uploadId, quality: 'fast' } })
        );
        let job: Record<string, unknown> = {};
        for (let i = 0; i < 10 && job.status !== 'completed'; i++) {
            job = text(await client.callTool({ name: 'get_job', arguments: { jobId, wait: 10 } }));
        }
        assert.equal(job.status, 'completed');
        await client.close();
    });
});
