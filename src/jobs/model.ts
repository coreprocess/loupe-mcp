import type { DocumentErrorCode } from '../reading/errors.ts';
import type { PageMethod, Quality, ReadResult } from '../reading/types.ts';
import type { DocumentType } from '../uploads/types.ts';

/** Who called a tool or issued a URL. */
export interface Caller {
    oid: string;
    name?: string | undefined;
}

export interface UploadRecord {
    uploadId: string;
    createdAt: string;
    expiresAt: string;
    createdBy: string;
}

/** A file an upload accepted. */
export interface UploadedFile {
    name: string;
    /** The SHA-256 of the name, its key in the store. */
    key: string;
    type: DocumentType;
    bytes: number;
    sha256: string;
    uploadedAt: string;
}

export interface JobRecord {
    jobId: string;
    uploadId: string;
    quality: Quality;
    language?: string;
    pages?: string;
    createdAt: string;
    expiresAt: string;
    createdBy: string;
    queueEntry: string;
    files: UploadedFile[];
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'expired';
export type DocumentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Where one page sits in a result file: its `<page>` element. */
export interface PageEntry {
    number: number;
    method: PageMethod;
    byteOffset: number;
    byteLength: number;
}

export interface DocumentState {
    status: DocumentStatus;
    format?: ReadResult['format'];
    pages?: PageEntry[];
    bytes?: number;
    sha256?: string;
    error?: { code: DocumentErrorCode; message: string };
    pagesDone?: number;
    pagesTotal?: number;
}

/** The job's state; `documents` lines up with the job record's files. Written only by the lease holder. */
export interface JobState {
    jobId: string;
    status: Exclude<JobStatus, 'expired'>;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    documents: DocumentState[];
}

export const FINAL_DOCUMENT_STATUSES: ReadonlySet<DocumentStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export const isFinalJobStatus = (status: JobStatus): boolean => status !== 'queued' && status !== 'running';
