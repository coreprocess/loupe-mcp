/** The document types Loupe accepts (concept §2), as media types. */
export const DOCUMENT_TYPES = {
    pdf: 'application/pdf',
    jpeg: 'image/jpeg',
    png: 'image/png',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docm: 'application/vnd.ms-word.document.macroenabled.12',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    html: 'text/html',
} as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES];

const IMAGE_TYPES: ReadonlySet<string> = new Set([
    DOCUMENT_TYPES.jpeg,
    DOCUMENT_TYPES.png,
    DOCUMENT_TYPES.bmp,
    DOCUMENT_TYPES.tiff,
    DOCUMENT_TYPES.heic,
    DOCUMENT_TYPES.heif,
]);

/** Raster images: read optically, one page each (a TIFF page by page). */
export const isImageType = (type: DocumentType): boolean => IMAGE_TYPES.has(type);

/** Office files and HTML: they carry their text, so both quality levels read them alike. */
export const isTextDocumentType = (type: DocumentType): boolean => type !== DOCUMENT_TYPES.pdf && !isImageType(type);
