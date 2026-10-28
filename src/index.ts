#!/usr/bin/env node
process.env.TZ = 'UTC';

import type { Server } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/env.ts';
import { errorMessage } from './core/errors.ts';
import { createLoggers } from './core/logger.ts';
import { Semaphore } from './core/semaphore.ts';
import { Signer } from './core/signing.ts';
import { VERSION } from './core/version.ts';
import { JobRunner } from './jobs/runner.ts';
import { JobService } from './jobs/service.ts';
import { PDF_READER_ENTRY, PdfReaderHost } from './reading/pdf/host.ts';
import { DocumentReader } from './reading/reader.ts';
import { DocumentIntelligence } from './reading/services/document-intelligence.ts';
import { VisionModel } from './reading/services/vision.ts';
import { createHttpApp, listen } from './server/http.ts';
import { AzureBlobStore } from './store/azureblob.ts';
import { FilesystemStore } from './store/filesystem.ts';
import type { Store } from './store/store.ts';
import { createMcpServer, type ToolContext } from './tools/tools.ts';
import { UploadService } from './uploads/uploads.ts';

const USAGE = `loupe-mcp ${VERSION} — MCP server that reads documents for AI agents

Usage: loupe-mcp [--env-file <path>]...

All configuration comes from environment variables (see docs/configuration.md).
  LOUPE_TRANSPORT=stdio|http   stdio for local use (default), http for deployments
  LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT, LOUPE_OPENAI_ENDPOINT, …

Options:
  --env-file <path>   load variables from a dotenv file (may be repeated)
  --help              show this help
  --version           show the version
`;

const SWEEP_INTERVAL_MS = 10 * 60_000;

/** pdf.js reader processes: two at a time, each with a 1 GiB heap; stalled ones are killed. */
const PDF_READER_OPTIONS = {
    entry: PDF_READER_ENTRY,
    openTimeoutMs: 3 * 60_000,
    idleTimeoutMs: 90_000,
    totalTimeoutMs: 10 * 60_000,
    maxConcurrent: 2,
    maxHeapMb: 1024,
};

const parseArgs = (argv: string[]): string[] => {
    const envFiles: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === '--help' || arg === '-h') {
            process.stdout.write(USAGE);
            process.exit(0);
        }
        if (arg === '--version') {
            process.stdout.write(`${VERSION}\n`);
            process.exit(0);
        }
        if (arg === '--env-file') {
            const file = argv[++i];
            if (!file) throw new Error('--env-file needs a path');
            envFiles.push(file);
        } else if (arg.startsWith('--env-file=')) {
            envFiles.push(arg.slice('--env-file='.length));
        } else {
            throw new Error(`Unknown argument '${arg}'`);
        }
    }
    return envFiles;
};

const main = async (): Promise<void> => {
    for (const file of parseArgs(process.argv.slice(2))) process.loadEnvFile(file);
    if (process.env.LOUPE_TRANSPORT !== 'http' && process.env.LOUPE_PORT === undefined) process.env.LOUPE_PORT = '0';
    const config = loadConfig();
    const loggers = createLoggers({ level: config.logLevel, auditLog: config.auditLog, transport: config.transport });
    const { log } = loggers;
    if (config.signingKeyGenerated) log.info('signing key generated for this process');

    const store: Store =
        config.store.kind === 'filesystem'
            ? new FilesystemStore(config.store.dir)
            : new AzureBlobStore({
                  accountUrl: config.store.accountUrl,
                  connectionString: config.store.connectionString,
                  container: config.store.container,
              });
    await store.init();

    const reader = new DocumentReader({
        documentIntelligence: new DocumentIntelligence(config.documentIntelligence, loggers),
        vision: new VisionModel(config.openai, config.vision.model, config.vision.reasoningEffort, loggers),
        pdfReader: new PdfReaderHost(PDF_READER_OPTIONS, log),
        visionSlots: new Semaphore(config.limits.visionConcurrency),
        limits: config.limits,
        loggers,
    });
    const runner = new JobRunner({ store, reader, limits: config.limits, loggers });
    const uploads = new UploadService(store, config.limits, config.retentionMs);
    const jobs = new JobService({
        store,
        uploads,
        limits: config.limits,
        retentionMs: config.retentionMs,
        loggers,
        wake: () => runner.wake(),
    });
    const signer = new Signer(config.signingKey);

    let publicUrl = config.publicUrl;
    const context: ToolContext = { config, uploads, jobs, signer, loggers, publicUrl: () => publicUrl };
    const app = createHttpApp(
        config,
        context,
        { store, jobs, uploads, signer, loggers },
        { mcp: config.transport === 'http' }
    );
    const { server, port } = await listen(app, config.host, config.port);
    if (!process.env.LOUPE_PUBLIC_URL)
        publicUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
    runner.start();
    log.info({ transport: config.transport, port, publicUrl, store: config.store.kind }, 'loupe started');

    let stopping = false;
    const shutdown = async (http: Server, reason: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        log.info({ reason }, 'shutting down');
        clearInterval(sweeper);
        http.close();
        await runner.shutdown();
        loggers.log.flush();
        loggers.audit.flush();
        setTimeout(() => process.exit(0), 200).unref();
    };

    if (config.transport === 'stdio') {
        const mcp = createMcpServer(context);
        await mcp.connect(new StdioServerTransport());
        const onClosed = () => void shutdown(server, 'stdin closed');
        if (process.stdin.readableEnded || process.stdin.destroyed) onClosed();
        process.stdin.once('end', onClosed).once('close', onClosed);
    }

    const sweeper = setInterval(
        () => void jobs.sweep().catch((error: unknown) => log.warn({ err: error }, 'sweep failed')),
        SWEEP_INTERVAL_MS
    );
    process.on('SIGTERM', () => void shutdown(server, 'SIGTERM'));
    process.on('SIGINT', () => void shutdown(server, 'SIGINT'));
    process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'));
};

main().catch((error: unknown) => {
    process.stderr.write(`loupe-mcp: ${errorMessage(error)}\n`);
    process.exit(1);
});
