/**
 * Reads one document at its quality level (concept §2, §6.1, §6.2): Office files and HTML through
 * Document Intelligence alone, PDFs and images through Document Intelligence for `fast`, and through
 * Document Intelligence, pdf.js and the vision model for `accurate`.
 */
import type { LimitsConfig } from '../config/env.ts';
import type { Loggers } from '../core/logger.ts';
import type { Semaphore } from '../core/semaphore.ts';
import { DOCUMENT_TYPES, isTextDocumentType } from '../uploads/types.ts';
import { fallbackPage } from './accurate/fallback.ts';
import { type DocumentContext, type PageInputs, transcribePage } from './accurate/transcribe.ts';
import { DocumentError } from './errors.ts';
import { imagePageCount, pageImage } from './images.ts';
import { prepareForAnalysis } from './office.ts';
import { includesPage, type PageRange, selectPages, toPageSpec } from './pages.ts';
import type { PdfFormData } from './pdf/form-data.ts';
import { type PdfReaderHost, PdfReaderInterruptedError, type PdfReaderOutput } from './pdf/host.ts';
import { AnalysisRefusedError, type DocumentIntelligence, type LayoutPage } from './services/document-intelligence.ts';
import type { VisionImage, VisionModel } from './services/vision.ts';
import type { ReadPage, ReadRequest, ReadResult } from './types.ts';

/** Pages rendered by one pdf.js process at a time, so page images never pile up in memory. */
const RENDER_CHUNK_PAGES = 8;

export interface ReaderDeps {
    documentIntelligence: DocumentIntelligence;
    vision: VisionModel;
    pdfReader: PdfReaderHost;
    /** Vision-model calls in flight, shared by every document of the replica. */
    visionSlots: Semaphore;
    limits: LimitsConfig;
    loggers: Loggers;
}

/** What is known of one page before the vision call. */
interface PreparedPage {
    number: number;
    layoutMarkdown: string | null;
    embeddedText: string | null;
    plainText: string | null;
    formData: PdfFormData | null;
}

const rangesSpec = (ranges: PageRange[] | undefined): string | undefined =>
    ranges?.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(',');

const markdownResult = (pages: LayoutPage[], selection: PageRange[] | undefined): ReadResult => ({
    format: 'markdown',
    pages: pages
        .filter((page) => includesPage(selection, page.number))
        .map((page) => ({ number: page.number, method: 'layout', content: page.markdown })),
});

export class DocumentReader {
    readonly #deps: ReaderDeps;

    constructor(deps: ReaderDeps) {
        this.#deps = deps;
    }

    async read(request: ReadRequest): Promise<ReadResult> {
        if (isTextDocumentType(request.type)) return this.#readTextDocument(request);
        if (request.type === DOCUMENT_TYPES.pdf) {
            return request.quality === 'fast' ? this.#readPdfFast(request) : this.#readPdfAccurate(request);
        }
        return request.quality === 'fast' ? this.#readImageFast(request) : this.#readImageAccurate(request);
    }

    /** The selected pages of a document with a known page count; too many of them fail the document. */
    #select(request: ReadRequest, pageCount: number): number[] {
        const pages = selectPages(request.pages, pageCount);
        if (pages.length > this.#deps.limits.maxPages) {
            throw new DocumentError(
                'too_many_pages',
                `The document has ${pages.length} selected pages; the limit is ${this.#deps.limits.maxPages}. Select fewer with pages.`
            );
        }
        return pages;
    }

    #layout(request: ReadRequest, content: Buffer, highResolution: boolean, pages: string | undefined) {
        return this.#deps.documentIntelligence.analyzeLayout(content, {
            highResolution,
            locale: request.language,
            pages,
            signal: request.signal,
        });
    }

    /** The layout transcript, or null when the service refused the file; other failures propagate. */
    async #layoutOrRefused(request: ReadRequest, pages: string | undefined): Promise<LayoutPage[] | null> {
        try {
            return await this.#layout(request, request.content, true, pages);
        } catch (error) {
            if (!(error instanceof AnalysisRefusedError)) throw error;
            this.#deps.loggers.log.info({ document: request.name, reason: error.message }, 'continuing without OCR');
            return null;
        }
    }

    async #readTextDocument(request: ReadRequest): Promise<ReadResult> {
        const content = await prepareForAnalysis(request.type, request.content);
        const result = markdownResult(await this.#layout(request, content, false, undefined), request.pages);
        request.progress(result.pages.length, result.pages.length);
        return result;
    }

    /** pdf.js output for the pages asked for; undefined when it cannot open the file or its process ends. */
    async #pdfJs(request: ReadRequest, contentPages: number[], renderPages: number[]) {
        try {
            return await this.#deps.pdfReader.run(
                { content: request.content, contentPages, renderPages },
                request.signal
            );
        } catch (error) {
            if (!(error instanceof PdfReaderInterruptedError)) throw error;
            this.#deps.loggers.log.warn({ document: request.name, reason: error.message }, 'pdf.js interrupted');
            return undefined;
        }
    }

    /** The selected pages, when pdf.js can count the PDF's pages; undefined when it cannot. */
    async #pdfSelection(request: ReadRequest): Promise<number[] | undefined> {
        const counted = await this.#pdfJs(request, [], []);
        return counted ? this.#select(request, counted.pageCount) : undefined;
    }

    async #readPdfFast(request: ReadRequest): Promise<ReadResult> {
        const selected = await this.#pdfSelection(request);
        if (selected?.length === 0) return { format: 'markdown', pages: [] };
        const spec = selected ? toPageSpec(selected) : rangesSpec(request.pages);
        const result = markdownResult(await this.#layout(request, request.content, false, spec), request.pages);
        request.progress(result.pages.length, result.pages.length);
        return result;
    }

    async #readImageFast(request: ReadRequest): Promise<ReadResult> {
        const pageCount = await imagePageCount(request.type, request.content);
        const selected = this.#select(request, pageCount);
        if (selected.length === 0) return { format: 'markdown', pages: [] };
        const spec = pageCount > 1 ? toPageSpec(selected) : undefined;
        const result = markdownResult(await this.#layout(request, request.content, false, spec), request.pages);
        request.progress(result.pages.length, result.pages.length);
        return result;
    }

    async #readPdfAccurate(request: ReadRequest): Promise<ReadResult> {
        const counted = await this.#pdfJs(request, [], []);
        const selected = counted ? this.#select(request, counted.pageCount) : undefined;
        if (selected?.length === 0) return { format: 'html', pages: [] };
        const spec = selected ? toPageSpec(selected) : rangesSpec(request.pages);
        const [layout, pdfJs] = await Promise.all([
            this.#layoutOrRefused(request, spec),
            selected ? this.#pdfJs(request, selected, []) : Promise.resolve(undefined),
        ]);
        const pages = this.#mergePdf(request, layout, pdfJs);
        const context: DocumentContext = { name: request.name, language: request.language, info: pdfJs?.info ?? null };
        const renderable = pdfJs !== undefined;
        return this.#transcribe(request, pages, context, async (numbers) => {
            const images = new Map<number, VisionImage>();
            if (!renderable) return images;
            const rendered = await this.#pdfJs(request, [], numbers);
            for (const page of rendered?.pages ?? []) {
                if (page.png) images.set(page.number, { mediaType: 'image/png', data: page.png });
            }
            return images;
        });
    }

    /**
     * The pages by number. When both sources agree on the pages, every page gets every input; when
     * they disagree, the transcript's pagination wins and the pdf.js fields are dropped, since a merge
     * would misalign them. When neither source can read the file, it is unreadable.
     */
    #mergePdf(request: ReadRequest, layout: LayoutPage[] | null, pdfJs: PdfReaderOutput | undefined): PreparedPage[] {
        const fromLayout = (page: LayoutPage): PreparedPage => ({
            number: page.number,
            layoutMarkdown: page.markdown,
            embeddedText: null,
            plainText: null,
            formData: null,
        });
        if (layout && pdfJs) {
            const byNumber = new Map(pdfJs.pages.map((page) => [page.number, page]));
            const agree = layout.length === pdfJs.pages.length && layout.every((page) => byNumber.has(page.number));
            if (!agree) {
                this.#deps.loggers.log.warn(
                    { document: request.name, layoutPages: layout.length, pdfJsPages: pdfJs.pages.length },
                    'Document Intelligence and pdf.js disagree on the pages; keeping the transcript'
                );
                return layout.map(fromLayout);
            }
            return layout.map((page) => {
                const other = byNumber.get(page.number);
                return {
                    ...fromLayout(page),
                    embeddedText: other?.embeddedText ?? null,
                    plainText: other?.plainText ?? null,
                    formData: other?.formData ?? null,
                };
            });
        }
        if (layout) return layout.filter((page) => includesPage(request.pages, page.number)).map(fromLayout);
        if (pdfJs) {
            return pdfJs.pages.map((page) => ({
                number: page.number,
                layoutMarkdown: null,
                embeddedText: page.embeddedText,
                plainText: page.plainText,
                formData: page.formData,
            }));
        }
        throw new DocumentError('unreadable', 'Neither Document Intelligence nor pdf.js could read the PDF');
    }

    async #readImageAccurate(request: ReadRequest): Promise<ReadResult> {
        const pageCount = await imagePageCount(request.type, request.content);
        const selected = this.#select(request, pageCount);
        if (selected.length === 0) return { format: 'html', pages: [] };
        const layout = await this.#layoutOrRefused(request, pageCount > 1 ? toPageSpec(selected) : undefined);
        const byNumber = new Map(layout?.map((page) => [page.number, page.markdown]));
        const pages = selected.map((number) => ({
            number,
            layoutMarkdown: byNumber.get(number) ?? null,
            embeddedText: null,
            plainText: null,
            formData: null,
        }));
        let decoded = 0;
        const result = await this.#transcribe(
            request,
            pages,
            { name: request.name, language: request.language, info: null },
            async (numbers) => {
                const images = new Map<number, VisionImage>();
                for (const number of numbers) {
                    try {
                        images.set(number, await pageImage(request.type, request.content, number));
                        decoded++;
                    } catch (error) {
                        // the transcript carries a page whose image cannot be decoded
                        if (!(error instanceof DocumentError)) throw error;
                        this.#deps.loggers.log.warn(
                            { document: request.name, reason: error.message },
                            'image not decoded'
                        );
                    }
                }
                return images;
            }
        );
        if (!layout && decoded === 0) throw new DocumentError('unreadable', 'The image could not be read');
        return result;
    }

    /**
     * The vision call for the pages in the window, a chunk of page images at a time, and the fallback
     * for every other page and every page the model did not deliver.
     */
    async #transcribe(
        request: ReadRequest,
        pages: PreparedPage[],
        context: DocumentContext,
        imagesFor: (numbers: number[]) => Promise<Map<number, VisionImage>>
    ): Promise<ReadResult> {
        const window = pages.slice(0, this.#deps.limits.accurateMaxPages);
        const output = new Map<number, ReadPage>();
        let done = 0;
        const finish = (page: ReadPage) => {
            output.set(page.number, page);
            request.progress(++done, pages.length);
        };
        const fallback = (page: PreparedPage): ReadPage => {
            const { html, method } = fallbackPage(page);
            return { number: page.number, method, content: html };
        };
        for (let start = 0; start < window.length; start += RENDER_CHUNK_PAGES) {
            const chunk = window.slice(start, start + RENDER_CHUNK_PAGES);
            const images = await imagesFor(chunk.map((page) => page.number));
            await Promise.all(
                chunk.map((page) =>
                    this.#deps.visionSlots.run(async () => {
                        const inputs: PageInputs = { ...page, image: images.get(page.number) ?? null };
                        const html = await transcribePage(this.#deps.vision, inputs, context, request.signal);
                        finish(html ? { number: page.number, method: 'vision', content: html } : fallback(page));
                    })
                )
            );
        }
        for (const page of pages.slice(window.length)) finish(fallback(page));
        return { format: 'html', pages: pages.map((page) => output.get(page.number) as ReadPage) };
    }
}
