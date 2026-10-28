import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { LimitsConfig } from '../../src/config/env.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { JobRunner, type Reader } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FilesystemStore } from '../../src/store/filesystem.ts';
import type { Store } from '../../src/store/store.ts';
import { UploadService } from '../../src/uploads/uploads.ts';

export const LIMITS: LimitsConfig = {
    maxFileBytes: 1024 * 1024,
    uploadMaxFiles: 10,
    uploadMaxBytes: 4 * 1024 * 1024,
    maxPages: 2000,
    accurateMaxPages: 100,
    maxJobDurationMs: 3_600_000,
    analysisConcurrency: 2,
    visionConcurrency: 2,
    maxActiveJobs: 4,
    readMaxBytes: 65_536,
};

export const RETENTION_MS = 2 * 86_400_000;

export interface JobsHarness {
    store: Store;
    uploads: UploadService;
    jobs: JobService;
    runner: JobRunner;
    dir: string;
    /** Another runner on the same store, as a second replica would be. */
    replica(reader: Reader): JobRunner;
    dispose(): Promise<void>;
}

export const createJobsHarness = async (
    reader: Reader,
    options: { limits?: Partial<LimitsConfig>; retentionMs?: number; dir?: string; store?: Store } = {}
): Promise<JobsHarness> => {
    const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'loupe-jobs-')));
    const store = options.store ?? new FilesystemStore(dir);
    await store.init();
    const limits = { ...LIMITS, ...options.limits };
    const loggers = nullLoggers();
    const retentionMs = options.retentionMs ?? RETENTION_MS;
    const uploads = new UploadService(store, limits, retentionMs);
    const runners: JobRunner[] = [];
    const replica = (replicaReader: Reader) => {
        const runner = new JobRunner({ store, reader: replicaReader, limits, loggers });
        runners.push(runner);
        return runner;
    };
    const runner = replica(reader);
    const jobs = new JobService({ store, uploads, limits, retentionMs, loggers, wake: () => runner.wake() });
    return {
        store,
        uploads,
        jobs,
        runner,
        dir,
        replica,
        dispose: async () => {
            for (const r of runners) await r.shutdown();
            if (!options.dir) await rm(dir, { recursive: true, force: true });
        },
    };
};

export const body = (data: Buffer | string): Readable => Readable.from([Buffer.from(data)]);
