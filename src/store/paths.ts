import { createHash } from 'node:crypto';

/**
 * Where everything lives in the store (concept §6.3). File names are never part of a path: a file is
 * stored under the SHA-256 of its name, so any accepted name fits every store.
 */
export const fileKey = (name: string): string => createHash('sha256').update(name, 'utf8').digest('hex');

export const paths = {
    uploads: 'uploads/',
    upload: (uploadId: string) => `uploads/${uploadId}/upload.json`,
    uploadPrefix: (uploadId: string) => `uploads/${uploadId}/`,
    uploadFile: (uploadId: string, key: string) => `uploads/${uploadId}/files/${key}`,
    accepted: (uploadId: string, key: string) => `uploads/${uploadId}/accepted/${key}.json`,
    acceptedPrefix: (uploadId: string) => `uploads/${uploadId}/accepted/`,
    jobs: 'jobs/',
    job: (jobId: string) => `jobs/${jobId}/job.json`,
    jobPrefix: (jobId: string) => `jobs/${jobId}/`,
    state: (jobId: string) => `jobs/${jobId}/state.json`,
    cancel: (jobId: string) => `jobs/${jobId}/cancel.json`,
    manifest: (jobId: string) => `jobs/${jobId}/manifest.json`,
    result: (jobId: string, index: number, extension: string) => `jobs/${jobId}/documents/${index}.${extension}`,
    queue: 'queue/',
    /** Queue entries sort by creation, so the oldest job is taken first. */
    queueEntry: (createdAt: string, jobId: string) => `queue/${createdAt.replace(/[-:.TZ]/g, '')}-${jobId}`,
};

/** The job ID of a queue entry: what follows the digits of its creation time. */
export const jobIdOfQueueEntry = (path: string): string => path.slice(path.indexOf('-') + 1);
