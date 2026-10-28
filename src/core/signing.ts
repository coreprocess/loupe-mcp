import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** What a signed URL grants: adding files to one upload, or reading one job's results. */
export type TokenPurpose = 'upload' | 'download';

/** The payload of a URL token: the upload or job ID, the issuing user and the expiry (seconds). */
export interface TokenPayload {
    id: string;
    user: string;
    expires: number;
}

/**
 * HMAC tokens for upload and download URLs. A separate key is derived per purpose, so a token
 * signed for one purpose never verifies for the other.
 */
export class Signer {
    readonly #keys: Record<TokenPurpose, Buffer>;

    constructor(secret: Buffer) {
        const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', secret, 'loupe', purpose, 32));
        this.#keys = { upload: derive('upload-token'), download: derive('download-token') };
    }

    /** Encodes the payload as `base64url(json).base64url(hmac)`. */
    sign(purpose: TokenPurpose, payload: TokenPayload): string {
        const body = Buffer.from(JSON.stringify({ i: payload.id, u: payload.user, e: payload.expires })).toString(
            'base64url'
        );
        return `${body}.${this.#mac(purpose, body)}`;
    }

    /** The payload if the signature is valid for the purpose, otherwise undefined. Expiry is the caller's check. */
    verify(purpose: TokenPurpose, token: string): TokenPayload | undefined {
        const dot = token.indexOf('.');
        if (dot <= 0 || dot !== token.lastIndexOf('.')) return undefined;
        const body = token.slice(0, dot);
        if (!safeEqual(token.slice(dot + 1), this.#mac(purpose, body))) return undefined;
        try {
            const raw: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (raw === null || typeof raw !== 'object') return undefined;
            const { i, u, e } = raw as Record<string, unknown>;
            if (typeof i !== 'string' || typeof u !== 'string' || typeof e !== 'number') return undefined;
            return { id: i, user: u, expires: e };
        } catch {
            return undefined;
        }
    }

    #mac(purpose: TokenPurpose, value: string): string {
        return createHmac('sha256', this.#keys[purpose]).update(value).digest('base64url');
    }
}

const safeEqual = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};
