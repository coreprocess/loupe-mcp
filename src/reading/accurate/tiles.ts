/**
 * Tiling of a page image for the vision model. The model downsamples an image beyond its detail
 * budget, so fine print and small form widgets on a full-page image blur before the model sees them.
 * A large page is cut into four overlapping tiles: horizontal bands for a portrait or square page, a
 * 2×2 grid for a landscape one. The overlap keeps content on a cut line whole in at least one tile.
 */
import sharp, { type Sharp } from 'sharp';
import type { VisionImage } from '../services/vision.ts';

/** A page whose long edge is shorter than this is small enough to send whole. */
const MIN_LONG_EDGE_PX = 1600;

/** Overlap between neighbouring tiles: a share of the tile size, clamped to a pixel range. */
const OVERLAP_RATIO = 0.15;
const OVERLAP_MIN_PX = 20;
const OVERLAP_MAX_PX = 200;

export type TileLayout = 'single' | 'bands' | 'grid';

/** A page as it goes to the model: one image, or four tiles in reading order. */
export interface PageImages {
    layout: TileLayout;
    images: VisionImage[];
}

interface Region {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** Splits the page when it is large enough; keeps the single image whenever a cut is not possible. */
export const tilePage = async (image: VisionImage): Promise<PageImages> => {
    const { width, height } = await sharp(image.data).metadata();
    if (!width || !height || Math.max(width, height) < MIN_LONG_EDGE_PX) return { layout: 'single', images: [image] };
    const layout = width > height ? 'grid' : 'bands';
    const regions = layout === 'grid' ? gridRegions(width, height) : bandRegions(width, height);
    if (!regions) return { layout: 'single', images: [image] };

    // One decoded source feeds all four cuts.
    const source = sharp(image.data);
    const encode = (tile: Sharp) =>
        image.mediaType === 'image/png' ? tile.png().toBuffer() : tile.jpeg({ quality: 90 }).toBuffer();
    const tiles = await Promise.all(regions.map((region) => encode(source.clone().extract(region))));
    return { layout, images: tiles.map((data: Buffer) => ({ mediaType: image.mediaType, data })) };
};

/** The overlap for a tile of the given size, or undefined when the tile is too small to overlap at all. */
const overlapFor = (segmentPx: number): number | undefined => {
    const clamped = Math.max(OVERLAP_MIN_PX, Math.min(OVERLAP_MAX_PX, Math.round(segmentPx * OVERLAP_RATIO)));
    const overlap = Math.min(clamped, Math.max(1, Math.floor(segmentPx / 2) - 1));
    return overlap < 1 ? undefined : overlap;
};

/**
 * Four full-width bands of equal height T with overlap o, so that 4T − 3o = H; of the overlaps that
 * divide evenly, the one closest to the preferred overlap.
 */
const bandRegions = (width: number, height: number): Region[] | undefined => {
    const quarter = Math.round(height / 4);
    const preferred = quarter < 8 ? undefined : overlapFor(quarter);
    if (preferred === undefined) return undefined;
    const maxOverlap = Math.min(OVERLAP_MAX_PX, Math.max(1, Math.floor(quarter / 2) - 1));
    let best: { tileHeight: number; overlap: number } | undefined;
    for (let overlap = OVERLAP_MIN_PX; overlap <= maxOverlap; overlap++) {
        if ((height + 3 * overlap) % 4 !== 0) continue;
        const tileHeight = (height + 3 * overlap) / 4;
        if (!best || Math.abs(overlap - preferred) < Math.abs(best.overlap - preferred)) best = { tileHeight, overlap };
    }
    if (!best) return undefined;
    const { tileHeight, overlap } = best;
    return [0, 1, 2, 3].map((index) => ({ left: 0, top: index * (tileHeight - overlap), width, height: tileHeight }));
};

/** Four quadrants in row-major order, each extended past the midlines by the overlap. */
const gridRegions = (width: number, height: number): Region[] | undefined => {
    const midX = Math.round(width / 2);
    const midY = Math.round(height / 2);
    const minSegment = Math.min(midX, width - midX, midY, height - midY);
    const overlap = minSegment < 8 ? undefined : overlapFor(minSegment);
    if (overlap === undefined) return undefined;
    const rightLeft = Math.max(0, midX - overlap);
    const bottomTop = Math.max(0, midY - overlap);
    const leftWidth = Math.min(width, midX + overlap);
    const topHeight = Math.min(height, midY + overlap);
    return [
        { left: 0, top: 0, width: leftWidth, height: topHeight },
        { left: rightLeft, top: 0, width: width - rightLeft, height: topHeight },
        { left: 0, top: bottomTop, width: leftWidth, height: height - bottomTop },
        { left: rightLeft, top: bottomTop, width: width - rightLeft, height: height - bottomTop },
    ];
};
