/**
 * The messages between Loupe and a PDF reader process. The request carries the bytes and which
 * pages to read and to render; the process answers with progress per page and one final result.
 * Buffers cross the channel intact because the process is forked with advanced serialization.
 */
import type { PdfFormData } from './form-data.ts';

export interface PdfReaderRequest {
    content: Buffer;
    /** Pages whose text layer and form fields are read. */
    contentPages: number[];
    /** Pages rendered to PNG. */
    renderPages: number[];
}

/** The PDF's info dictionary (Title, Author, Producer, …), string values only. */
export type PdfDocumentInfo = Record<string, string>;

/** What pdf.js yields for one page; what was not asked for or failed is null. */
export interface PdfReaderPage {
    number: number;
    /** The geometry report of the text layer, for the vision model. */
    embeddedText: string | null;
    /** The text layer as readable text, for the fallback. */
    plainText: string | null;
    formData: PdfFormData | null;
    png: Buffer | null;
}

export type PdfReaderPhase = 'open' | 'content' | 'render';

/** A page pdf.js failed on in one phase; the reader carries on. */
export interface PdfReaderWarning {
    phase: PdfReaderPhase;
    pageNumber: number;
    message: string;
}

export type PdfReaderResult =
    | { type: 'progress'; phase: PdfReaderPhase; pageNumber: number }
    | { type: 'result'; info: PdfDocumentInfo; pageCount: number; pages: PdfReaderPage[]; warnings: PdfReaderWarning[] }
    /** pdf.js could not open the file: a statement about the bytes, not a fault. */
    | { type: 'open-failed'; message: string };
