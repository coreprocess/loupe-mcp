import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { prepareForAnalysis } from '../../src/reading/office.ts';
import { DOCM_MAIN_PART, DOCX_MAIN_PART, detectType } from '../../src/uploads/detect.ts';
import { DOCUMENT_TYPES } from '../../src/uploads/types.ts';
import { bufferReader, readZipDirectory, readZipEntry, replaceZipEntry, ZipError } from '../../src/uploads/zip.ts';
import { makeOffice } from '../helpers/office.ts';
import { makePdf } from '../helpers/pdf.ts';

const detect = (data: Buffer) => detectType(bufferReader(data), data.length);

const header = (...bytes: number[]) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]);

describe('type detection', () => {
    it('recognizes every accepted type by its content', async () => {
        const bmp = Buffer.alloc(64);
        bmp.write('BM', 0, 'latin1');
        bmp.writeUInt32LE(40, 14);
        const heic = Buffer.alloc(64);
        heic.write('ftypheic', 4, 'latin1');
        const heif = Buffer.alloc(64);
        heif.write('ftypmif1', 4, 'latin1');
        const cases: [Buffer, string][] = [
            [makePdf(['one']), DOCUMENT_TYPES.pdf],
            [header(0xff, 0xd8, 0xff, 0xe0), DOCUMENT_TYPES.jpeg],
            [header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), DOCUMENT_TYPES.png],
            [header(0x49, 0x49, 0x2a, 0x00), DOCUMENT_TYPES.tiff],
            [header(0x4d, 0x4d, 0x00, 0x2a), DOCUMENT_TYPES.tiff],
            [bmp, DOCUMENT_TYPES.bmp],
            [heic, DOCUMENT_TYPES.heic],
            [heif, DOCUMENT_TYPES.heif],
            [makeOffice('docx'), DOCUMENT_TYPES.docx],
            [makeOffice('docm'), DOCUMENT_TYPES.docm],
            [makeOffice('xlsx'), DOCUMENT_TYPES.xlsx],
            [makeOffice('pptx'), DOCUMENT_TYPES.pptx],
            [Buffer.from('﻿<!-- note -->\n<!DOCTYPE html><html><body>Hi</body></html>'), DOCUMENT_TYPES.html],
            [Buffer.from('<html lang="en"><body>Hi</body></html>'), DOCUMENT_TYPES.html],
            [Buffer.concat([Buffer.from('junk before the header\n'), makePdf(['x'])]), DOCUMENT_TYPES.pdf],
        ];
        for (const [data, type] of cases) assert.equal(await detect(data), type);
    });

    it('refuses everything else', async () => {
        const avif = Buffer.alloc(64);
        avif.write('ftypavif', 4, 'latin1');
        const plainZip = Buffer.from(zipSync({ 'a.txt': strToU8('hello') }));
        const template = Buffer.from(
            zipSync({
                '[Content_Types].xml': strToU8(
                    '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"/></Types>'
                ),
            })
        );
        for (const data of [
            Buffer.alloc(0),
            Buffer.from('plain text, not a document'),
            Buffer.from('<?xml version="1.0"?><invoice/>'),
            Buffer.from('<div>fragment</div>'),
            avif,
            plainZip,
            template,
            Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
            header(0x42, 0x4d),
        ]) {
            assert.equal(await detect(data), undefined);
        }
    });

    it('does not inflate oversized or bomb-like content types', async () => {
        // 64 MiB of zeros compress to a few kilobytes; the reader stops at its 1 MiB limit
        const bomb = Buffer.from(
            zipSync({ '[Content_Types].xml': new Uint8Array(64 * 1024 * 1024), 'word/document.xml': strToU8('x') })
        );
        assert.ok(bomb.length < 1024 * 1024);
        assert.equal(await detect(bomb), undefined);
    });

    it('refuses an entry that inflates beyond the size it states', async () => {
        const archive = Buffer.from(zipSync({ '[Content_Types].xml': new Uint8Array(8 * 1024 * 1024) }, { level: 9 }));
        const { entries } = await readZipDirectory(bufferReader(archive), archive.length);
        const entry = entries[0];
        assert.ok(entry);
        // the directory now claims 100 bytes; the stream still inflates to 8 MiB
        const directory = archive.indexOf(entry.record);
        archive.writeUInt32LE(100, directory + 24);
        archive.writeUInt32LE(100, entry.localHeaderOffset + 22);
        const [lying] = (await readZipDirectory(bufferReader(archive), archive.length)).entries;
        assert.equal(lying?.uncompressedSize, 100);
        await assert.rejects(readZipEntry(bufferReader(archive), lying as typeof entry, 1024 * 1024), ZipError);
        assert.equal(await detect(archive), undefined);
    });
});

describe('Office packages', () => {
    it('rewrites a macro-enabled Word package into a plain one, copying everything else', async () => {
        const macro = new Uint8Array([1, 2, 3, 4]);
        const docm = makeOffice('docm', { 'word/vbaProject.bin': macro });
        const docx = await prepareForAnalysis(DOCUMENT_TYPES.docm, docm);
        const files = unzipSync(new Uint8Array(docx));
        const types = Buffer.from(files['[Content_Types].xml'] as Uint8Array).toString('utf8');
        assert.ok(types.includes(DOCX_MAIN_PART) && !types.includes(DOCM_MAIN_PART));
        assert.deepEqual(files['word/vbaProject.bin'], macro);
        assert.equal(Buffer.from(files['word/document.xml'] as Uint8Array).toString(), '<document>Hello</document>');
        assert.equal(await detect(docx), DOCUMENT_TYPES.docx);
    });

    it('leaves every other file as it is', async () => {
        const docx = makeOffice('docx');
        assert.equal(await prepareForAnalysis(DOCUMENT_TYPES.docx, docx), docx);
    });

    it('replaces an entry of an archive that carries data descriptors', async () => {
        const archive = makeOffice('docx');
        const replaced = await replaceZipEntry(archive, 'word/document.xml', Buffer.from('<document>New</document>'));
        const files = unzipSync(new Uint8Array(replaced));
        assert.equal(Buffer.from(files['word/document.xml'] as Uint8Array).toString(), '<document>New</document>');
    });
});
