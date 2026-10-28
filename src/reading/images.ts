/**
 * Raster images as page images for the vision model (concept §6.2): upright by their EXIF
 * orientation, at most 4096 pixels on the long edge, as JPEG. HEIC/HEIF and BMP are decoded first,
 * since sharp's own build reads neither; TIFF is read page by page. Every decoder checks the stated
 * size before it decodes a pixel, so a small file cannot claim a gigantic picture.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import decodeHeic from 'heic-decode';
import sharp, { type Sharp } from 'sharp';
import { DOCUMENT_TYPES, type DocumentType } from '../uploads/types.ts';
import { DocumentError } from './errors.ts';
import type { VisionImage } from './services/vision.ts';

const MAX_PIXELS = 100_000_000;
const MAX_LONG_EDGE = 4096;
const JPEG_QUALITY = 90;

const unreadable = (detail: string, cause?: unknown): DocumentError =>
    new DocumentError('unreadable', `The image could not be decoded: ${detail}`, { cause });

const checkSize = (width: number | undefined, height: number | undefined): void => {
    if (!width || !height) throw unreadable('no image size');
    if (width * height > MAX_PIXELS) throw unreadable(`${width} by ${height} pixels exceeds the limit`);
};

/** The size a BMP header states; the canvas decodes every pixel as it loads, so it is checked first. */
const bmpSize = (content: Buffer): { width: number; height: number } => {
    if (content.length < 26) throw unreadable('truncated BMP header');
    const headerSize = content.readUInt32LE(14);
    if (headerSize === 12) return { width: content.readUInt16LE(18), height: content.readUInt16LE(20) };
    return { width: Math.abs(content.readInt32LE(18)), height: Math.abs(content.readInt32LE(22)) };
};

/** The pages of an image file: a TIFF's page count, 1 for everything else. */
export const imagePageCount = async (type: DocumentType, content: Buffer): Promise<number> => {
    if (type !== DOCUMENT_TYPES.tiff) return 1;
    try {
        return (await sharp(content, { limitInputPixels: MAX_PIXELS }).metadata()).pages ?? 1;
    } catch (error) {
        throw unreadable('unreadable TIFF', error);
    }
};

/** Opens the page as a sharp pipeline, upright where the format states an orientation. */
const open = async (type: DocumentType, content: Buffer, page: number): Promise<Sharp> => {
    if (type === DOCUMENT_TYPES.heic || type === DOCUMENT_TYPES.heif) {
        const header = await sharp(content).metadata();
        checkSize(header.width, header.height);
        // the decoder applies the rotation the container states
        const { width, height, data } = await decodeHeic({ buffer: content });
        return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
            raw: { width, height, channels: 4 },
        });
    }
    if (type === DOCUMENT_TYPES.bmp) {
        const stated = bmpSize(content);
        checkSize(stated.width, stated.height);
        const image = await loadImage(content);
        const context = createCanvas(image.width, image.height).getContext('2d');
        context.drawImage(image, 0, 0);
        const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
        return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
            raw: { width, height, channels: 4 },
        });
    }
    const options = { limitInputPixels: MAX_PIXELS, ...(type === DOCUMENT_TYPES.tiff ? { page: page - 1 } : {}) };
    checkSize(
        ...(await sharp(content, options)
            .metadata()
            .then((meta) => [meta.width, meta.height] as const))
    );
    return sharp(content, options).rotate();
};

/** One page of an image file as the vision model takes it. */
export const pageImage = async (type: DocumentType, content: Buffer, page: number): Promise<VisionImage> => {
    try {
        const image = await open(type, content, page);
        const data = await image
            .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();
        return { mediaType: 'image/jpeg', data };
    } catch (error) {
        if (error instanceof DocumentError) throw error;
        throw unreadable(error instanceof Error ? error.message : String(error), error);
    }
};
