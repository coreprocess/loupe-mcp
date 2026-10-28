import { DOCUMENT_TYPES, type DocumentType } from './types.ts';
import { type RangeReader, readZipDirectory, readZipEntry, ZipError } from './zip.ts';

/**
 * Detects a document's type by its content, never by its name (concept §2): magic bytes for PDF and
 * the image formats, the package's own content types for Office files, a document prolog for HTML.
 * Anything else is no accepted type.
 */

const HEAD_BYTES = 4096;
const PDF_SEARCH_BYTES = 1024;
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);
const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/** The content type of a plain Word package's main part, and that of a macro-enabled one. */
export const DOCX_MAIN_PART = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
export const DOCM_MAIN_PART = 'application/vnd.ms-word.document.macroEnabled.main+xml';

/** The Office main-part content types, and the document type each one makes. */
const OFFICE_MAIN_PARTS: [string, DocumentType][] = [
    [DOCX_MAIN_PART, DOCUMENT_TYPES.docx],
    [DOCM_MAIN_PART, DOCUMENT_TYPES.docm],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', DOCUMENT_TYPES.xlsx],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', DOCUMENT_TYPES.pptx],
];

const startsWith = (head: Buffer, bytes: number[], offset = 0): boolean =>
    head.length >= offset + bytes.length && bytes.every((byte, i) => head[offset + i] === byte);

const imageType = (head: Buffer): DocumentType | undefined => {
    if (startsWith(head, [0xff, 0xd8, 0xff])) return DOCUMENT_TYPES.jpeg;
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return DOCUMENT_TYPES.png;
    if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
        return DOCUMENT_TYPES.tiff;
    }
    if (startsWith(head, [0x42, 0x4d]) && head.length >= 18 && BMP_HEADER_SIZES.has(head.readUInt32LE(14))) {
        return DOCUMENT_TYPES.bmp;
    }
    if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
        const brand = head.toString('latin1', 8, 12);
        if (HEIC_BRANDS.has(brand)) return DOCUMENT_TYPES.heic;
        if (HEIF_BRANDS.has(brand)) return DOCUMENT_TYPES.heif;
    }
    return undefined;
};

/** Whether the text starts like an HTML document, after a BOM, whitespace and comments. */
const isHtml = (head: Buffer): boolean => {
    let text = head.toString('utf8').replace(/^﻿/, '');
    for (;;) {
        text = text.trimStart();
        if (!text.startsWith('<!--')) break;
        const end = text.indexOf('-->');
        if (end < 0) return false;
        text = text.slice(end + 3);
    }
    return /^<!doctype\s+html[\s>]/i.test(text) || /^<html[\s>]/i.test(text);
};

const officeType = async (read: RangeReader, size: number): Promise<DocumentType | undefined> => {
    try {
        const { entries } = await readZipDirectory(read, size);
        const entry = entries.find((candidate) => candidate.name === '[Content_Types].xml');
        if (!entry) return undefined;
        const xml = (await readZipEntry(read, entry, MAX_CONTENT_TYPES_BYTES)).toString('utf8');
        const found = OFFICE_MAIN_PARTS.filter(([contentType]) => xml.includes(`"${contentType}"`));
        return found.length === 1 ? found[0]?.[1] : undefined;
    } catch (error) {
        if (error instanceof ZipError) return undefined;
        throw error;
    }
};

/** The document type of the stored bytes, or undefined when Loupe does not accept them. */
export const detectType = async (read: RangeReader, size: number): Promise<DocumentType | undefined> => {
    if (size === 0) return undefined;
    const head = await read(0, Math.min(size, HEAD_BYTES));
    const image = imageType(head);
    if (image) return image;
    if (head.toString('latin1', 0, 5) === '%PDF-') return DOCUMENT_TYPES.pdf;
    if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return officeType(read, size);
    if (isHtml(head)) return DOCUMENT_TYPES.html;
    // PDF readers accept a header after leading bytes, within the first kilobyte
    if (head.subarray(0, PDF_SEARCH_BYTES).includes('%PDF-')) return DOCUMENT_TYPES.pdf;
    return undefined;
};
