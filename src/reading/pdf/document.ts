/**
 * pdf.js in Node: opens a PDF once and exposes per-page text, form fields and PNG rendering. The
 * rendering scale is chosen so that a page carries no more pixels than the vision model keeps, while
 * a scan declared at "1 pt = 1 px" cannot blow up the bitmap.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, RenderParameters } from 'pdfjs-dist/types/src/display/api.js';
import { type PdfFormData, readFormData } from './form-data.ts';
import type { PdfDocumentInfo } from './messages.ts';
import { readPageTextLayer } from './page-text.ts';

/** Rendering resolution: the highest input DPI at which every pixel still reaches the vision model. */
const TARGET_DPI = 200;

/** Megapixel ceilings on the rendered bitmap: a properly declared A4 page renders at full target DPI under the soft cap. */
const SOFT_MAX_MP = 5;
const HARD_MAX_MP = 8;

/** Upper bound on the scale factor for pathological pages declared far below a point in size. */
const MAX_SCALE = 4;

/** The largest image pdf.js decodes, in pixels; beyond it the image is skipped. */
const MAX_IMAGE_PIXELS = 100_000_000;

/** Deadline for one page's render or text read. */
const PAGE_TIMEOUT_MS = 60_000;

const pdfjsPackageRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

export interface PdfPageContent {
    embeddedText: string;
    plainText: string;
    formData: PdfFormData;
}

export interface OpenedPdf {
    pageCount: number;
    info: PdfDocumentInfo;
    renderPagePng(pageNumber: number): Promise<Buffer>;
    getPageContent(pageNumber: number): Promise<PdfPageContent>;
    destroy(): Promise<void>;
}

/**
 * Opens a PDF with the font, CMap, wasm decoder and ICC assets pdf.js needs in Node; without the wasm
 * decoders, JPEG2000 and JBIG2 scan pages render blank. No system fonts and no network: the file is
 * all pdf.js gets. Throws when pdf.js cannot open the file.
 */
export async function openPdf(data: Buffer): Promise<OpenedPdf> {
    // pdf.js takes ownership of the bytes and may detach them, so it gets its own copy.
    const document = await pdfjs.getDocument({
        standardFontDataUrl: toPdfJsDirectory(path.join(pdfjsPackageRoot, 'standard_fonts')),
        cMapUrl: toPdfJsDirectory(path.join(pdfjsPackageRoot, 'cmaps')),
        cMapPacked: true,
        wasmUrl: toPdfJsDirectory(path.join(pdfjsPackageRoot, 'wasm')),
        iccUrl: toPdfJsDirectory(path.join(pdfjsPackageRoot, 'iccs')),
        useSystemFonts: false,
        maxImageSize: MAX_IMAGE_PIXELS,
        data: new Uint8Array(data),
    }).promise;

    const rawInfo = (await document.getMetadata()).info;
    return {
        pageCount: document.numPages,
        info: sanitizeDocumentInfo(rawInfo),
        renderPagePng: (pageNumber) => renderPagePng(document, pageNumber),
        getPageContent: (pageNumber) => readPageContent(document, pageNumber),
        destroy: () => document.loadingTask.destroy(),
    };
}

/** pdf.js wants its asset directories as absolute paths with forward slashes, ending in `/`. */
function toPdfJsDirectory(absoluteDirectory: string): string {
    const posix = path.resolve(absoluteDirectory).split(path.sep).join('/');
    return posix.endsWith('/') ? posix : `${posix}/`;
}

/** The scale that hits the target DPI unless the megapixel caps or the absolute bound cut it short. */
function computeRenderScale(unscaledWidth: number, unscaledHeight: number): number {
    const fromDpi = TARGET_DPI / 72;
    const sourceMp = (unscaledWidth * unscaledHeight) / 1_000_000;
    const dpiTargetMp = sourceMp * fromDpi * fromDpi;
    const cap = dpiTargetMp <= SOFT_MAX_MP ? SOFT_MAX_MP : HARD_MAX_MP;
    const fromMpCap = Math.sqrt(cap / sourceMp);
    return Math.min(fromDpi, fromMpCap, MAX_SCALE);
}

/** Renders one page to PNG on pdf.js's Node canvas, bounded by the page deadline. */
async function renderPagePng(document: PDFDocumentProxy, pageNumber: number): Promise<Buffer> {
    const page = await document.getPage(pageNumber);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: computeRenderScale(unscaled.width, unscaled.height) });
    // The Node canvas factory is untyped at runtime; only the members used here are named.
    const canvasFactory = document.canvasFactory as {
        create: (
            width: number,
            height: number
        ) => { canvas: { toBuffer(format: 'image/png'): Buffer; width: number; height: number } };
    };
    const { canvas } = canvasFactory.create(viewport.width, viewport.height);
    const renderTask = page.render({ canvas: canvas as unknown as RenderParameters['canvas'], viewport });
    // pdf.js resumes between operator chunks through a microtask, which never lets the event loop
    // turn; a macrotask lets the page deadline fire during a long render.
    renderTask.onContinue = (proceed: () => void) => setImmediate(proceed);

    // Whatever happens, the bitmap and the page's image and font caches are released now, not at the next GC.
    try {
        await withPageDeadline(renderTask.promise, pageNumber, 'render', () => renderTask.cancel());
        return canvas.toBuffer('image/png');
    } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
    }
}

/** Reads the text layer and the form fields of one page, bounded by the page deadline. */
async function readPageContent(document: PDFDocumentProxy, pageNumber: number): Promise<PdfPageContent> {
    const page: PDFPageProxy = await document.getPage(pageNumber);
    try {
        const [textLayer, formData] = await withPageDeadline(
            Promise.all([readPageTextLayer(page), readFormData(page)]),
            pageNumber,
            'read',
            () => undefined
        );
        return { embeddedText: textLayer.report, plainText: textLayer.plain, formData };
    } finally {
        page.cleanup();
    }
}

/** Races a page operation against the deadline; `abandon` tells pdf.js to stop when the deadline wins. */
async function withPageDeadline<T>(
    operation: Promise<T>,
    pageNumber: number,
    what: 'render' | 'read',
    abandon: () => void
): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            abandon();
            reject(new Error(`pdf.js page ${what} timed out after ${PAGE_TIMEOUT_MS}ms (page ${pageNumber})`));
        }, PAGE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([operation, deadline]);
    } finally {
        clearTimeout(timeoutHandle);
    }
}

/** String entries of the info dictionary, stripped of the UTF-16 BOM and nul bytes some producers leave in. */
function sanitizeDocumentInfo(info: object): PdfDocumentInfo {
    const result: PdfDocumentInfo = {};
    for (const [key, value] of Object.entries(info)) {
        if (typeof value === 'string') result[key] = value.replace(/^þÿ/, '').replaceAll('\u0000', '');
    }
    return result;
}
