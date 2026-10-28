import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';
import { DocumentError } from '../../src/reading/errors.ts';
import { parsePageSelection } from '../../src/reading/pages.ts';
import type { DocumentReader } from '../../src/reading/reader.ts';
import type { Quality, ReadRequest } from '../../src/reading/types.ts';
import { DOCUMENT_TYPES, type DocumentType } from '../../src/uploads/types.ts';
import { MockServices } from '../helpers/mock-services.ts';
import { makeOffice } from '../helpers/office.ts';
import { makePdf } from '../helpers/pdf.ts';
import { createReader } from '../helpers/reader.ts';

const mock = new MockServices();
const PDF = makePdf(['First page', 'Second page', 'Third page'], { formField: { name: 'customer', value: 'Ada' } });

const request = (
    type: DocumentType,
    content: Buffer,
    quality: Quality,
    extra: Partial<ReadRequest> = {}
): ReadRequest => ({
    name: 'document',
    type,
    content,
    quality,
    language: undefined,
    pages: undefined,
    signal: AbortSignal.timeout(120_000),
    progress: () => undefined,
    ...extra,
});

const isDocumentError = (code: string) => (error: unknown) => error instanceof DocumentError && error.code === code;

describe('document reader', () => {
    let reader: DocumentReader;

    before(async () => {
        await mock.start();
        reader = createReader(mock).reader;
    });
    after(() => mock.stop());
    beforeEach(() => mock.reset());

    it('reads a PDF fast: the layout transcript of the selected pages', async () => {
        const result = await reader.read(
            request(DOCUMENT_TYPES.pdf, PDF, 'fast', { pages: parsePageSelection('2-5') })
        );
        assert.equal(result.format, 'markdown');
        assert.deepEqual(
            result.pages.map((page) => [page.number, page.method]),
            [
                [2, 'layout'],
                [3, 'layout'],
            ]
        );
        assert.match(result.pages[0]?.content ?? '', /OCR text of page 2/);
        assert.equal(mock.analyzeCalls[0]?.query.get('pages'), '2-3');
        assert.equal(mock.analyzeCalls[0]?.query.has('features'), false);
        assert.equal(mock.visionCalls.length, 0);
    });

    it('reads a PDF accurately: every input per page reconciled by the vision model', async () => {
        const progress: number[] = [];
        const result = await reader.read(
            request(DOCUMENT_TYPES.pdf, PDF, 'accurate', { language: 'en', progress: (done) => progress.push(done) })
        );
        assert.equal(result.format, 'html');
        assert.deepEqual(
            result.pages.map((page) => [page.number, page.method, page.content]),
            [
                [1, 'vision', '<p>Vision page 1</p>'],
                [2, 'vision', '<p>Vision page 2</p>'],
                [3, 'vision', '<p>Vision page 3</p>'],
            ]
        );
        assert.deepEqual(progress, [1, 2, 3]);
        assert.equal(mock.analyzeCalls[0]?.query.get('features'), 'ocrHighResolution');
        const first = mock.visionCalls.find((call) => call.page === 1);
        assert.equal(first?.images, 1);
        assert.match(first?.text ?? '', /str="First page"/);
        assert.match(first?.text ?? '', /"customer"/);
        assert.match(first?.text ?? '', /OCR text of page 1/);
        assert.match(first?.text ?? '', /## Language\n\nen/);
    });

    it('falls back page by page where the vision model does not deliver', async () => {
        mock.behavior.rejectPages.add(2);
        mock.behavior.truncatePages.add(3);
        const result = await reader.read(request(DOCUMENT_TYPES.pdf, PDF, 'accurate'));
        assert.deepEqual(
            result.pages.map((page) => page.method),
            ['vision', 'layout', 'layout']
        );
        assert.match(result.pages[1]?.content ?? '', /<p>OCR text of page 2<\/p>/);
    });

    it('carries a PDF with pdf.js alone when Document Intelligence refuses it', async () => {
        mock.behavior.refuseAnalyze = true;
        mock.behavior.rejectPages.add(3);
        const result = await reader.read(request(DOCUMENT_TYPES.pdf, PDF, 'accurate'));
        assert.deepEqual(
            result.pages.map((page) => page.method),
            ['vision', 'vision', 'text-layer']
        );
        assert.match(result.pages[2]?.content ?? '', /Third page/);
    });

    it('fails a PDF neither source can read, and one with too many pages', async () => {
        mock.behavior.refuseAnalyze = true;
        await assert.rejects(
            reader.read(request(DOCUMENT_TYPES.pdf, Buffer.from('%PDF-1.7 broken'), 'accurate')),
            isDocumentError('unreadable')
        );
        await assert.rejects(reader.read(request(DOCUMENT_TYPES.pdf, PDF, 'fast')), isDocumentError('unreadable'));
        mock.reset();
        const limited = createReader(mock, { LOUPE_MAX_PAGES: '2' }).reader;
        await assert.rejects(limited.read(request(DOCUMENT_TYPES.pdf, PDF, 'fast')), isDocumentError('too_many_pages'));
        const selected = await limited.read(
            request(DOCUMENT_TYPES.pdf, PDF, 'fast', { pages: parsePageSelection('1,3') })
        );
        assert.equal(selected.pages.length, 2);
    });

    it('transcribes only the vision window and reads the rest as fast', async () => {
        const windowed = createReader(mock, { LOUPE_ACCURATE_MAX_PAGES: '1' }).reader;
        const result = await windowed.read(request(DOCUMENT_TYPES.pdf, PDF, 'accurate'));
        assert.deepEqual(
            result.pages.map((page) => page.method),
            ['vision', 'layout', 'layout']
        );
        assert.equal(mock.visionCalls.length, 1);
    });

    it('reads images: one page each, a TIFF page by page', async () => {
        const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#ffffff' } })
            .png()
            .toBuffer();
        const result = await reader.read(request(DOCUMENT_TYPES.png, png, 'accurate'));
        assert.deepEqual(
            result.pages.map((page) => [page.number, page.method]),
            [[1, 'vision']]
        );
        assert.equal(mock.visionCalls[0]?.images, 1);
        assert.equal(mock.analyzeCalls[0]?.query.has('pages'), false);

        mock.reset();
        const raw = Buffer.alloc(100 * 300 * 3, 255);
        const tiff = await sharp(raw, { raw: { width: 100, height: 300, channels: 3, pageHeight: 100 } })
            .tiff()
            .toBuffer();
        const pages = await reader.read(
            request(DOCUMENT_TYPES.tiff, tiff, 'accurate', { pages: parsePageSelection('2') })
        );
        assert.deepEqual(
            pages.pages.map((page) => page.number),
            [2]
        );
        assert.equal(mock.analyzeCalls[0]?.query.get('pages'), '2');
    });

    it('reads Office files through the layout model alone at both levels', async () => {
        for (const quality of ['fast', 'accurate'] as const) {
            mock.reset();
            const result = await reader.read(request(DOCUMENT_TYPES.docm, makeOffice('docm'), quality));
            assert.equal(result.format, 'markdown');
            assert.equal(mock.analyzeCalls[0]?.query.has('features'), false);
            assert.equal(mock.visionCalls.length, 0);
        }
    });

    it('fails a document when the services stay unavailable', async () => {
        mock.behavior.forceStatus = 403;
        await assert.rejects(
            reader.read(request(DOCUMENT_TYPES.pdf, PDF, 'fast')),
            isDocumentError('service_unavailable')
        );
    });
});
