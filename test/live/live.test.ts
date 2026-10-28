/**
 * Opt-in check against real Azure Document Intelligence and Azure OpenAI resources (concept §10):
 * `pnpm test:live` with the endpoints and keys in `.env.live` (gitignored, see .env.example). Every
 * document is generated here; no real document is used. Skipped when no endpoint is configured.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import { parsePageSelection } from '../../src/reading/pages.ts';
import type { Quality, ReadResult } from '../../src/reading/types.ts';
import { DOCUMENT_TYPES, type DocumentType } from '../../src/uploads/types.ts';
import { makeWord } from '../helpers/office.ts';
import { makePdf } from '../helpers/pdf.ts';
import { createReader } from '../helpers/reader.ts';

const configured = Boolean(process.env.LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT && process.env.LOUPE_OPENAI_ENDPOINT);

/** A photo-like scan: a slightly rotated, noisy page with a small table of amounts. */
const scan = async (): Promise<Buffer> => {
    const canvas = createCanvas(1240, 1754);
    const context = canvas.getContext('2d');
    context.fillStyle = '#f4f1ea';
    context.fillRect(0, 0, 1240, 1754);
    context.fillStyle = '#222';
    context.font = '48px sans-serif';
    context.fillText('Invoice 2026-0815', 120, 200);
    context.font = '32px sans-serif';
    const rows = [
        ['Item', 'Amount'],
        ['Inspection', '1.250,00 EUR'],
        ['Material', '380,50 EUR'],
        ['Total', '1.630,50 EUR'],
    ];
    rows.forEach(([item, amount], index) => {
        context.fillText(item ?? '', 120, 340 + index * 60);
        context.fillText(amount ?? '', 760, 340 + index * 60);
    });
    context.strokeRect(100, 300, 1000, 260);
    context.fillText('[x] paid   [ ] open', 120, 700);
    return sharp(canvas.toBuffer('image/png')).rotate(1.5, { background: '#f4f1ea' }).jpeg({ quality: 70 }).toBuffer();
};

const show = (name: string, quality: Quality, result: ReadResult): void => {
    process.stdout.write(`\n=== ${name} (${quality}) ===\n`);
    for (const page of result.pages)
        process.stdout.write(`--- page ${page.number} [${page.method}]\n${page.content}\n`);
};

describe('live services', {
    skip: !configured && 'no LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT / LOUPE_OPENAI_ENDPOINT',
}, () => {
    const documents = async (): Promise<[string, DocumentType, Buffer][]> => {
        const raw = Buffer.alloc(600 * 1600 * 3, 255);
        return [
            [
                'born-digital.pdf',
                DOCUMENT_TYPES.pdf,
                makePdf(['Service agreement', 'Second page: terms'], {
                    formField: { name: 'customer', value: 'Ada Lovelace' },
                }),
            ],
            ['scan.jpg', DOCUMENT_TYPES.jpeg, await scan()],
            [
                'fax.tif',
                DOCUMENT_TYPES.tiff,
                await sharp(raw, { raw: { width: 600, height: 1600, channels: 3, pageHeight: 800 } })
                    .tiff()
                    .toBuffer(),
            ],
            ['letter.docx', DOCUMENT_TYPES.docx, makeWord('docx', ['Dear customer,', 'your order 4711 has shipped.'])],
            ['macro.docm', DOCUMENT_TYPES.docm, makeWord('docm', ['A macro-enabled letter'])],
        ];
    };

    for (const quality of ['fast', 'accurate'] as const) {
        it(`reads every document type (${quality})`, { timeout: 30 * 60_000 }, async () => {
            const { reader } = createReader(undefined, {
                LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT: process.env.LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT as string,
                LOUPE_DOCUMENT_INTELLIGENCE_KEY: process.env.LOUPE_DOCUMENT_INTELLIGENCE_KEY ?? '',
                LOUPE_OPENAI_ENDPOINT: process.env.LOUPE_OPENAI_ENDPOINT as string,
                LOUPE_OPENAI_KEY: process.env.LOUPE_OPENAI_KEY ?? '',
                LOUPE_VISION_MODEL: process.env.LOUPE_VISION_MODEL ?? 'gpt-5.6-luna',
            });
            for (const [name, type, content] of await documents()) {
                const result = await reader.read({
                    name,
                    type,
                    content,
                    quality,
                    language: 'en',
                    pages: name === 'fax.tif' ? parsePageSelection('1-2') : undefined,
                    signal: AbortSignal.timeout(20 * 60_000),
                    progress: () => undefined,
                });
                show(name, quality, result);
                assert.ok(result.pages.length > 0, name);
            }
        });
    }
});
