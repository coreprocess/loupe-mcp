/**
 * Page HTML without the vision model (concept §6.2): for the pages after the vision window and for
 * every page the model did not deliver. Best input first: the Document Intelligence transcript
 * rendered from Markdown, else the readable text layer and the form fields, else a placeholder.
 */
import MarkdownIt from 'markdown-it';
import type { PdfFormData } from '../pdf/form-data.ts';
import type { PageMethod } from '../types.ts';

export interface FallbackInputs {
    layoutMarkdown: string | null;
    /** The text layer as readable text. */
    plainText: string | null;
    formData: PdfFormData | null;
}

export const UNREADABLE_PAGE = '<p>(page could not be read)</p>';

/** Document Intelligence writes literal `<table>` markup into its Markdown; the renderer lets it through. */
const markdown = new MarkdownIt({ html: true, breaks: false, linkify: false });

export const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const fallbackPage = (inputs: FallbackInputs): { html: string; method: PageMethod } => {
    if (inputs.layoutMarkdown?.trim()) return { html: markdown.render(inputs.layoutMarkdown).trim(), method: 'layout' };
    const parts: string[] = [];
    if (inputs.plainText?.trim()) parts.push(`<pre>${escapeHtml(inputs.plainText)}</pre>`);
    if (inputs.formData && inputs.formData.fields.length > 0) {
        parts.push(`<pre>${escapeHtml(JSON.stringify(inputs.formData.fields, null, 2))}</pre>`);
    }
    if (parts.length > 0) return { html: parts.join('\n'), method: 'text-layer' };
    return { html: UNREADABLE_PAGE, method: 'none' };
};
