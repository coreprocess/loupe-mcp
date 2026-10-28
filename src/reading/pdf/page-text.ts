/**
 * The text layer of one PDF page in two readings. The report is for the vision model: every text run
 * with its string, direction, transform, size and font, the marked-content boundaries, and the font
 * styles, in content-stream order, so the model can resolve the reading order from the geometry. The
 * plain text is for storage when no model reads the page: the runs joined in stream order, a line
 * break where the layer marks one. Both are empty for a page without a single text run.
 */
import type { PDFPageProxy, TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api.js';

/** The two readings of a page's text layer; both `''` when the page has no text runs. */
export type PageTextLayer = {
    report: string;
    plain: string;
};

/** Reads the text layer once and derives both readings; nul bytes some producers emit are dropped. */
export async function readPageTextLayer(page: PDFPageProxy): Promise<PageTextLayer> {
    const textContent = await page.getTextContent({ includeMarkedContent: true });
    const runs = textContent.items.filter(isTextItem);
    if (runs.length === 0) {
        return { report: '', plain: '' };
    }

    // The report: header, then runs and marked-content boundaries interleaved in stream order.
    const lines: string[] = [`lang: ${textContent.lang ?? '(none)'}`, '', '--- items (content stream order) ---'];
    let runIndex = 0;
    for (const item of textContent.items) {
        if (isTextItem(item)) {
            runIndex += 1;
            lines.push(formatTextRun(runIndex, item));
        } else if (isMarkedContent(item)) {
            lines.push(formatMarkedContent(item));
        }
    }
    lines.push('', '--- styles (by font name) ---', formatStyles(textContent.styles));

    // The plain text: run strings as they come, a newline where the layer ends a line.
    const plain = runs.map((run) => run.str + (run.hasEOL ? '\n' : '')).join('');
    return {
        report: lines.join('\n').replaceAll('\u0000', '').trim(),
        plain: plain.replaceAll('\u0000', '').trim(),
    };
}

/** A text run, as opposed to a marked-content boundary. */
function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
    return 'str' in item && typeof item.str === 'string';
}

/** A marked-content boundary (begin/end of a tagged region). */
function isMarkedContent(item: TextItem | TextMarkedContent): item is TextMarkedContent {
    return !('str' in item) && typeof item.type === 'string';
}

/** One report line per run: the string and the geometry the model needs to place it. */
function formatTextRun(index: number, item: TextItem): string {
    return [
        `${index}.`,
        `str=${JSON.stringify(item.str)}`,
        `dir=${item.dir}`,
        `transform=[${Array.from(item.transform).map(round4).join(', ')}]`,
        `width=${round4(item.width)}`,
        `height=${round4(item.height)}`,
        `fontName=${item.fontName}`,
        item.hasEOL ? 'hasEOL' : '',
    ]
        .filter(Boolean)
        .join(' ');
}

/** A boundary line; the id ties begin and end together. */
function formatMarkedContent(item: TextMarkedContent): string {
    return `marked: ${item.type}${item.id !== undefined ? ` id=${JSON.stringify(item.id)}` : ''}`;
}

/** The styles map that resolves the font names of the runs. */
function formatStyles(styles: Record<string, unknown> | undefined): string {
    if (!styles || Object.keys(styles).length === 0) {
        return '(none)';
    }
    return Object.entries(styles)
        .map(
            ([name, style]) => `${name}: ${style && typeof style === 'object' ? JSON.stringify(style) : String(style)}`
        )
        .join('\n');
}

/** Four decimals keep the geometry readable without losing placement. */
function round4(value: number): string {
    return value.toFixed(4);
}
