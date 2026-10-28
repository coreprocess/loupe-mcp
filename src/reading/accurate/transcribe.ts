/**
 * One vision call per page (concept §6.2). The model gets every signal the preparation found (the
 * page image, tiled when large, the text layer, the form fields, the OCR transcript) and reconciles
 * them into one HTML fragment. Every input taken from the document travels between per-request
 * fences, so text in the document cannot pose as a section of the prompt.
 */
import { randomBytes } from 'node:crypto';
import type { PdfFormData } from '../pdf/form-data.ts';
import type { PdfDocumentInfo } from '../pdf/messages.ts';
import type { VisionImage, VisionModel } from '../services/vision.ts';
import { PAGE_PROMPT } from './prompt.ts';
import { type PageImages, tilePage } from './tiles.ts';

/** Everything known about one page; any input may be missing. */
export interface PageInputs {
    number: number;
    image: VisionImage | null;
    embeddedText: string | null;
    formData: PdfFormData | null;
    layoutMarkdown: string | null;
}

export interface DocumentContext {
    name: string;
    language: string | undefined;
    info: PdfDocumentInfo | null;
}

const LAYOUT_DESCRIPTIONS: Record<PageImages['layout'], string> = {
    single: 'Attached above as a single full-page image.',
    bands: 'Attached above as four overlapping horizontal bands, top to bottom.',
    grid: 'Attached above as four overlapping quadrants in row-major order (top-left, top-right, bottom-left, bottom-right).',
};

/** The model wraps its answer in a code fence now and then, despite being told not to. */
const CODE_FENCE = /^```(?:html)?\s*\n([\s\S]*?)\n?```$/;

const hasInput = (page: PageInputs): boolean =>
    page.image !== null ||
    Boolean(page.embeddedText) ||
    (page.formData?.fields.length ?? 0) > 0 ||
    Boolean(page.layoutMarkdown?.trim());

/**
 * The page's HTML, or null when the model could not deliver it (a rejected input, a cut-off answer)
 * or there is nothing to send; the caller then takes the fallback. Outages propagate.
 */
export const transcribePage = async (
    model: VisionModel,
    page: PageInputs,
    document: DocumentContext,
    signal: AbortSignal
): Promise<string | null> => {
    if (!hasInput(page)) return null;
    const tiles = page.image ? await tilePage(page.image) : null;
    const fence = randomBytes(8).toString('hex');
    const outcome = await model.complete({
        system: PAGE_PROMPT.replaceAll('{{fence}}', fence),
        images: tiles?.images ?? [],
        text: userText(page, document, tiles, fence),
        signal,
    });
    if (outcome.kind === 'rejected') return null;
    return outcome.text.replace(CODE_FENCE, '$1').trim() || null;
};

/** One `##` section per input, in the order the instructions announce; a missing input is marked `(empty)`. */
export const userText = (
    page: PageInputs,
    document: DocumentContext,
    tiles: PageImages | null,
    fence: string
): string => {
    // the fence must not occur in the data itself, or the data could close its own section
    const fenced = (content: string) => `<<<DATA-${fence}>>>\n${content.replaceAll(fence, '')}\n<<<END-${fence}>>>`;
    const info = document.info && Object.keys(document.info).length > 0 ? document.info : null;
    const sections = [
        '## Document metadata',
        info ? fenced(JSON.stringify(info, null, 2)) : '(empty)',
        '## File name',
        fenced(document.name),
        '## Language',
        document.language ?? '(empty)',
        '## Page number',
        String(page.number),
        '## Page image',
        tiles ? LAYOUT_DESCRIPTIONS[tiles.layout] : '(no image available)',
        '## Page text layer',
        page.embeddedText ? fenced(page.embeddedText) : '(empty)',
        '## Page form fields (JSON)',
        page.formData && page.formData.fields.length > 0
            ? fenced(JSON.stringify(page.formData.fields, null, 2))
            : '(empty)',
        '## Page OCR transcript (Markdown)',
        page.layoutMarkdown?.trim() ? fenced(page.layoutMarkdown) : '(empty)',
    ];
    return sections.join('\n\n');
};
