import { createHash } from 'node:crypto';
import type { ReadResult } from '../reading/types.ts';
import type { DocumentState, JobRecord, JobState, JobStatus, PageEntry } from './model.ts';

/**
 * The result files and the manifest (concept §2, §6.6). A result file holds one `<page number="N">`
 * element per page; the page index records each element's byte range, so a window or a `curl -r`
 * fetches single pages.
 */

export const extensionOf = (format: ReadResult['format']): string => (format === 'markdown' ? 'md' : 'html');

const PAGE_OPEN = /^<page number="\d+">\n/;
const PAGE_CLOSE = /\n<\/page>\n*$/;

export const renderResult = (result: ReadResult): { body: Buffer; pages: PageEntry[]; sha256: string } => {
    const parts: Buffer[] = [];
    const pages: PageEntry[] = [];
    let offset = 0;
    for (const page of result.pages) {
        const element = Buffer.from(`<page number="${page.number}">\n${page.content}\n</page>\n\n`, 'utf8');
        pages.push({ number: page.number, method: page.method, byteOffset: offset, byteLength: element.length });
        parts.push(element);
        offset += element.length;
    }
    const body = Buffer.concat(parts);
    return { body, pages, sha256: createHash('sha256').update(body).digest('hex') };
};

/** The content of a `<page>` element. */
export const pageContent = (element: string): string => element.replace(PAGE_OPEN, '').replace(PAGE_CLOSE, '');

/** The download path of a document's result, relative to the manifest and percent-encoded. */
export const resultPath = (name: string, format: ReadResult['format']): string =>
    `documents/${encodeURIComponent(name)}.${extensionOf(format)}`;

/** How many pages each method produced. */
export const methodCounts = (pages: PageEntry[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const page of pages) counts[page.method] = (counts[page.method] ?? 0) + 1;
    return counts;
};

export const jobStatusOf = (job: JobRecord, state: JobState, now = Date.now()): JobStatus =>
    now > Date.parse(job.expiresAt) ? 'expired' : state.status;

const documentEntry = (job: JobRecord, document: DocumentState, index: number) => {
    const file = job.files[index];
    return {
        name: file?.name,
        status: document.status,
        type: file?.type,
        sourceBytes: file?.bytes,
        sourceSha256: file?.sha256,
        ...(document.status === 'succeeded' && document.format && file
            ? {
                  format: document.format,
                  path: resultPath(file.name, document.format),
                  bytes: document.bytes,
                  sha256: document.sha256,
                  pages: document.pages,
              }
            : {}),
        ...(document.error ? { error: document.error } : {}),
    };
};

export const manifestOf = (job: JobRecord, state: JobState) => ({
    version: 1,
    jobId: job.jobId,
    quality: job.quality,
    status: jobStatusOf(job, state),
    documents: state.documents.map((document, index) => documentEntry(job, document, index)),
    createdAt: job.createdAt,
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    expiresAt: job.expiresAt,
});
