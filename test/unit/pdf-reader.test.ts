import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { PDF_READER_ENTRY, PdfReaderHost, PdfReaderInterruptedError } from '../../src/reading/pdf/host.ts';
import { makePdf } from '../helpers/pdf.ts';

const silent = { warn: () => undefined };

const host = (
    entry: URL,
    timeouts: Partial<{ openTimeoutMs: number; idleTimeoutMs: number; totalTimeoutMs: number }> = {}
) =>
    new PdfReaderHost(
        {
            entry,
            openTimeoutMs: 30_000,
            idleTimeoutMs: 30_000,
            totalTimeoutMs: 60_000,
            maxConcurrent: 1,
            maxHeapMb: 512,
            ...timeouts,
        },
        silent
    );

describe('pdf.js reader process', () => {
    it('reads text layers and form fields and renders pages', async () => {
        const pdf = makePdf(['First page', 'Second page', 'Third page'], {
            formField: { name: 'customer', value: 'Ada' },
        });
        const output = await host(PDF_READER_ENTRY).run(
            { content: pdf, contentPages: [1, 3, 9], renderPages: [2] },
            AbortSignal.timeout(60_000)
        );
        assert.ok(output);
        assert.equal(output.pageCount, 3);
        assert.deepEqual(
            output.pages.map((page) => page.number),
            [1, 2, 3]
        );
        const [first, second, third] = output.pages;
        assert.match(first?.plainText ?? '', /First page/);
        assert.match(first?.embeddedText ?? '', /str="First page"/);
        assert.deepEqual(
            first?.formData?.fields.map((field) => field.kind === 'text' && [field.name, field.value]),
            [['customer', 'Ada']]
        );
        assert.equal(first?.png, null);
        assert.equal(second?.plainText, null);
        assert.ok(second?.png);
        const rendered = await sharp(second.png).metadata();
        assert.equal(rendered.format, 'png');
        assert.ok((rendered.width ?? 0) > 1000);
        assert.match(third?.plainText ?? '', /Third page/);
    });

    it('counts pages without reading them', async () => {
        const output = await host(PDF_READER_ENTRY).run(
            { content: makePdf(['a', 'b']), contentPages: [], renderPages: [] },
            AbortSignal.timeout(60_000)
        );
        assert.equal(output?.pageCount, 2);
        assert.deepEqual(output?.pages, []);
    });

    it('answers undefined for a file pdf.js cannot open', async () => {
        const output = await host(PDF_READER_ENTRY).run(
            { content: Buffer.from('%PDF-1.7 not really'), contentPages: [1], renderPages: [] },
            AbortSignal.timeout(60_000)
        );
        assert.equal(output, undefined);
    });

    it('kills a reader that stops reporting pages', async () => {
        const stalling = host(new URL('../fixtures/stalling-child.ts', import.meta.url), { idleTimeoutMs: 300 });
        await assert.rejects(
            stalling.run(
                { content: Buffer.from('x'), contentPages: [1], renderPages: [] },
                AbortSignal.timeout(60_000)
            ),
            (error: unknown) => error instanceof PdfReaderInterruptedError && /no progress/.test(error.message)
        );
    });

    it('reports a reader that dies, with its last words', async () => {
        const crashing = host(new URL('../fixtures/crashing-child.ts', import.meta.url));
        await assert.rejects(
            crashing.run(
                { content: Buffer.from('x'), contentPages: [1], renderPages: [] },
                AbortSignal.timeout(60_000)
            ),
            (error: unknown) => error instanceof PdfReaderInterruptedError && /heap limit/.test(error.message)
        );
    });

    it('kills the reader when the job is cancelled', async () => {
        const stalling = host(new URL('../fixtures/stalling-child.ts', import.meta.url));
        const controller = new AbortController();
        const run = stalling.run({ content: Buffer.from('x'), contentPages: [1], renderPages: [] }, controller.signal);
        setTimeout(() => controller.abort(new Error('cancelled')), 200);
        await assert.rejects(run, /cancelled/);
    });
});
