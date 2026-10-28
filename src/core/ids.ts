import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type IdKind = 'upload' | 'job';

const PREFIX: Record<IdKind, string> = { upload: 'u_', job: 'j_' };

/** 128 random bits, base62-encoded, with a prefix per kind (`u_`, `j_`). Unguessable and URL-safe. */
export const newId = (kind: IdKind): string => {
    let n = BigInt(`0x${randomBytes(16).toString('hex')}`);
    let out = '';
    for (let i = 0; i < 22; i++) {
        out = ALPHABET[Number(n % 62n)] + out;
        n /= 62n;
    }
    return `${PREFIX[kind]}${out}`;
};

export const isId = (kind: IdKind, value: string): boolean =>
    new RegExp(`^${PREFIX[kind]}[0-9A-Za-z]{22}$`).test(value);
