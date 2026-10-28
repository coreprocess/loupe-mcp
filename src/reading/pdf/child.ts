/**
 * The PDF reader process: opens one PDF with pdf.js, reads the text layer and form fields of the
 * pages asked for, renders the pages asked for, and sends the result to the parent. It runs as its
 * own process because pdf.js can wedge a thread in native code and decoded images can exhaust a
 * heap; the parent kills a process that stops reporting pages. It imports nothing that holds a
 * credential or reaches the network.
 */
import { type OpenedPdf, openPdf } from './document.ts';
import type { PdfReaderPage, PdfReaderRequest, PdfReaderResult, PdfReaderWarning } from './messages.ts';

const channel = process.send?.bind(process);
if (!channel) throw new Error('The PDF reader process was started without an IPC channel');

const send = (message: PdfReaderResult): void => {
    channel(message);
};

const readPages = async (pdf: OpenedPdf, request: PdfReaderRequest): Promise<PdfReaderResult> => {
    const warnings: PdfReaderWarning[] = [];
    const pages = new Map<number, PdfReaderPage>();
    const pageOf = (number: number): PdfReaderPage => {
        let page = pages.get(number);
        if (!page) {
            page = { number, embeddedText: null, plainText: null, formData: null, png: null };
            pages.set(number, page);
        }
        return page;
    };
    const inRange = (numbers: number[]) => numbers.filter((n) => n >= 1 && n <= pdf.pageCount);

    for (const number of inRange(request.contentPages)) {
        const page = pageOf(number);
        try {
            const content = await pdf.getPageContent(number);
            page.embeddedText = content.embeddedText || null;
            page.plainText = content.plainText || null;
            page.formData = content.formData;
        } catch (error) {
            warnings.push({ phase: 'content', pageNumber: number, message: String(error) });
        }
        send({ type: 'progress', phase: 'content', pageNumber: number });
    }
    for (const number of inRange(request.renderPages)) {
        try {
            pageOf(number).png = await pdf.renderPagePng(number);
        } catch (error) {
            warnings.push({ phase: 'render', pageNumber: number, message: String(error) });
        }
        send({ type: 'progress', phase: 'render', pageNumber: number });
    }
    return {
        type: 'result',
        info: pdf.info,
        pageCount: pdf.pageCount,
        pages: [...pages.values()].sort((a, b) => a.number - b.number),
        warnings,
    };
};

const answer = async (request: PdfReaderRequest): Promise<PdfReaderResult> => {
    let pdf: OpenedPdf;
    try {
        pdf = await openPdf(Buffer.from(request.content));
    } catch (error) {
        return { type: 'open-failed', message: String(error) };
    }
    send({ type: 'progress', phase: 'open', pageNumber: 0 });
    try {
        return await readPages(pdf, request);
    } finally {
        await pdf.destroy();
    }
};

// One request per process: do the task, answer, exit once the answer has left.
process.once('message', (request: PdfReaderRequest) => {
    answer(request)
        .then((result) => channel(result, () => process.exit(0)))
        .catch((error: unknown) => {
            process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
            process.exit(1);
        });
});
