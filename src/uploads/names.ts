import { LoupeError } from '../core/errors.ts';

const MAX_NAME_BYTES = 255;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rule refuses
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Decodes and checks a file name from an upload URL (concept §6.5): one path segment, valid UTF-8,
 * at most 255 bytes, no control characters, no `/` or `\`, not `.` or `..`.
 */
export const decodeFileName = (segment: string): string => {
    let name: string;
    try {
        name = decodeURIComponent(segment);
    } catch {
        throw new LoupeError('invalid_argument', 'The file name is not valid percent-encoded UTF-8');
    }
    checkFileName(name);
    return name;
};

export const checkFileName = (name: string): void => {
    if (name === '' || name === '.' || name === '..') throw new LoupeError('invalid_argument', 'Invalid file name');
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
        throw new LoupeError('invalid_argument', `The file name exceeds ${MAX_NAME_BYTES} bytes`);
    }
    if (CONTROL.test(name)) throw new LoupeError('invalid_argument', 'The file name contains control characters');
    if (name.includes('/') || name.includes('\\')) {
        throw new LoupeError('invalid_argument', 'The file name contains a slash or backslash');
    }
    if (name.isWellFormed?.() === false) throw new LoupeError('invalid_argument', 'The file name is not valid UTF-8');
};
