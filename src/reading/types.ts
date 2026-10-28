import type { DocumentType } from '../uploads/types.ts';
import type { PageRange } from './pages.ts';

export type Quality = 'fast' | 'accurate';

/** What produced a page (concept §2). */
export type PageMethod = 'vision' | 'layout' | 'text-layer' | 'none';

export interface ReadPage {
    number: number;
    method: PageMethod;
    content: string;
}

export interface ReadResult {
    format: 'markdown' | 'html';
    pages: ReadPage[];
}

export interface ReadRequest {
    name: string;
    type: DocumentType;
    content: Buffer;
    quality: Quality;
    language: string | undefined;
    pages: PageRange[] | undefined;
    signal: AbortSignal;
    /** Reports progress in pages: done so far of the total. */
    progress(done: number, total: number): void;
}
