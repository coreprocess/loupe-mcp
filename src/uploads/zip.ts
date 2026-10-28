import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Just enough of ZIP for Office files: the central directory, one small entry, and replacing an
 * entry. Nothing is extracted beyond the entry asked for, every read is bounded, and ZIP64 archives
 * are refused, so a crafted archive cannot make Loupe inflate or read more than these limits.
 */

/** Reads `length` bytes at `offset` of the archive. */
export type RangeReader = (offset: number, length: number) => Promise<Buffer>;

export interface ZipEntry {
    name: string;
    flags: number;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    /** The entry's central directory record as stored. */
    record: Buffer;
}

export interface ZipDirectory {
    entries: ZipEntry[];
    directoryOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_BYTES = 22;
const MAX_COMMENT = 0xffff;
const MAX_ENTRIES = 20_000;
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
const UTF8_FLAG = 0x800;

export class ZipError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ZipError';
    }
}

/** Reads the central directory; throws `ZipError` for anything that is no plain ZIP archive. */
export const readZipDirectory = async (read: RangeReader, size: number): Promise<ZipDirectory> => {
    const tailLength = Math.min(size, EOCD_BYTES + MAX_COMMENT);
    const tail = await read(size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new ZipError('no end of central directory');
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0)
        throw new ZipError('multi-disk archive');
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
        throw new ZipError('ZIP64 archive');
    }
    if (count > MAX_ENTRIES || directorySize > MAX_DIRECTORY_BYTES) throw new ZipError('directory too large');
    if (directoryOffset + directorySize > size - tailLength + eocd) throw new ZipError('directory out of bounds');

    const directory = await read(directoryOffset, directorySize);
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
        if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw new ZipError('bad directory');
        const nameLength = directory.readUInt16LE(at + 28);
        const length = 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
        if (at + length > directory.length) throw new ZipError('bad directory');
        const flags = directory.readUInt16LE(at + 8);
        const entry: ZipEntry = {
            name: directory.toString(flags & UTF8_FLAG ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength),
            flags,
            method: directory.readUInt16LE(at + 10),
            compressedSize: directory.readUInt32LE(at + 20),
            uncompressedSize: directory.readUInt32LE(at + 24),
            localHeaderOffset: directory.readUInt32LE(at + 42),
            record: directory.subarray(at, at + length),
        };
        if (
            entry.compressedSize === 0xffffffff ||
            entry.uncompressedSize === 0xffffffff ||
            entry.localHeaderOffset === 0xffffffff
        ) {
            throw new ZipError('ZIP64 entry');
        }
        if (entry.localHeaderOffset >= directoryOffset) throw new ZipError('entry out of bounds');
        entries.push(entry);
        at += length;
    }
    return { entries, directoryOffset };
};

/** The entry's content, at most `maxBytes` long; a larger, encrypted or unknown entry throws `ZipError`. */
export const readZipEntry = async (read: RangeReader, entry: ZipEntry, maxBytes: number): Promise<Buffer> => {
    if (entry.flags & 0x1) throw new ZipError('encrypted entry');
    if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) throw new ZipError('entry too large');
    const header = await read(entry.localHeaderOffset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw new ZipError('bad local header');
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = await read(start, entry.compressedSize);
    if (data.length !== entry.compressedSize) throw new ZipError('truncated entry');
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new ZipError(`compression method ${entry.method}`);
    try {
        return inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch {
        throw new ZipError('entry does not inflate within its limit');
    }
};

/** A reader over an archive held in memory. */
export const bufferReader =
    (buffer: Buffer): RangeReader =>
    async (offset, length) =>
        buffer.subarray(offset, offset + length);

/**
 * The archive with one entry's content replaced, stored uncompressed. Every other entry is copied
 * as stored, so nothing else is inflated.
 */
export const replaceZipEntry = async (archive: Buffer, name: string, content: Buffer): Promise<Buffer> => {
    const { entries, directoryOffset } = await readZipDirectory(bufferReader(archive), archive.length);
    const target = entries.find((entry) => entry.name === name);
    if (!target) throw new ZipError(`no entry ${name}`);
    const byOffset = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    const parts: Buffer[] = [];
    const newOffsets = new Map<ZipEntry, number>();
    let written = 0;
    byOffset.forEach((entry, index) => {
        newOffsets.set(entry, written);
        const end = byOffset[index + 1]?.localHeaderOffset ?? directoryOffset;
        let part: Buffer;
        if (entry === target) {
            const nameBytes = entry.record.subarray(46, 46 + entry.record.readUInt16LE(28));
            const header = Buffer.alloc(30);
            header.writeUInt32LE(LOCAL, 0);
            header.writeUInt16LE(20, 4);
            header.writeUInt16LE(entry.flags & UTF8_FLAG, 6);
            header.writeUInt16LE(0, 8);
            entry.record.copy(header, 10, 12, 16);
            header.writeUInt32LE(crc32(content), 14);
            header.writeUInt32LE(content.length, 18);
            header.writeUInt32LE(content.length, 22);
            header.writeUInt16LE(nameBytes.length, 26);
            header.writeUInt16LE(0, 28);
            part = Buffer.concat([header, nameBytes, content]);
        } else {
            part = archive.subarray(entry.localHeaderOffset, end);
        }
        parts.push(part);
        written += part.length;
    });
    const directoryStart = written;
    for (const entry of entries) {
        const record = Buffer.from(entry.record);
        record.writeUInt32LE(newOffsets.get(entry) as number, 42);
        if (entry === target) {
            record.writeUInt16LE(entry.flags & UTF8_FLAG, 8);
            record.writeUInt16LE(0, 10);
            record.writeUInt32LE(crc32(content), 16);
            record.writeUInt32LE(content.length, 20);
            record.writeUInt32LE(content.length, 24);
        }
        parts.push(record);
        written += record.length;
    }
    const eocd = Buffer.alloc(EOCD_BYTES);
    eocd.writeUInt32LE(EOCD, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(written - directoryStart, 12);
    eocd.writeUInt32LE(directoryStart, 16);
    parts.push(eocd);
    return Buffer.concat(parts);
};
