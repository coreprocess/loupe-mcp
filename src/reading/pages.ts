import { LoupeError } from '../core/errors.ts';

/** An inclusive range of page numbers, counted from 1. */
export type PageRange = readonly [number, number];

const MAX_PAGE_NUMBER = 100_000;
const SELECTION = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

/** Parses a page selection such as `1-3,7` (concept §5.2). */
export const parsePageSelection = (spec: string): PageRange[] => {
    const compact = spec.replace(/\s+/g, '');
    if (!SELECTION.test(compact)) {
        throw new LoupeError('invalid_argument', `Invalid page selection '${spec}'; expected e.g. 1-3,7`);
    }
    return compact.split(',').map((part) => {
        const [from, to = from] = part.split('-').map(Number) as [number, number?];
        if (from < 1 || (to as number) < from || (to as number) > MAX_PAGE_NUMBER) {
            throw new LoupeError('invalid_argument', `Invalid page range '${part}'`);
        }
        return [from, to as number] as const;
    });
};

export const includesPage = (ranges: PageRange[] | undefined, page: number): boolean =>
    !ranges || ranges.some(([from, to]) => page >= from && page <= to);

/** The selected pages a document with `pageCount` pages has, ascending; all of them without a selection. */
export const selectPages = (ranges: PageRange[] | undefined, pageCount: number): number[] => {
    const pages: number[] = [];
    for (let page = 1; page <= pageCount; page++) if (includesPage(ranges, page)) pages.push(page);
    return pages;
};

/** Ascending page numbers in the services' compact syntax: `1-3,7`. */
export const toPageSpec = (pages: number[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < pages.length; i++) {
        const from = pages[i] as number;
        let to = from;
        while (pages[i + 1] === to + 1) to = pages[++i] as number;
        parts.push(from === to ? String(from) : `${from}-${to}`);
    }
    return parts.join(',');
};
