/** Why a document failed (concept §5.3); `cancelled` is a status of its own. */
export type DocumentErrorCode = 'unreadable' | 'too_many_pages' | 'timeout' | 'service_unavailable' | 'internal';

/** A document could not be read; the code and message are shown to the agent. */
export class DocumentError extends Error {
    readonly code: DocumentErrorCode;

    constructor(code: DocumentErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DocumentError';
        this.code = code;
    }
}
