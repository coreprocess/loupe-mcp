/**
 * Error types that cross module boundaries. Every error that reaches an MCP client or an HTTP
 * response is a LoupeError with a stable code.
 */

export type ErrorCode =
    | 'config_invalid'
    | 'invalid_argument'
    | 'not_found'
    | 'expired'
    | 'forbidden'
    | 'unauthorized'
    | 'conflict'
    | 'too_large'
    | 'unsupported_type'
    | 'limit_exceeded'
    | 'internal';

export class LoupeError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'LoupeError';
        this.code = code;
    }
}

export const isLoupeError = (error: unknown): error is LoupeError => error instanceof LoupeError;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const SUMMARY_CHARS = 300;

/**
 * What a client sees of a foreign error: its first line, shortened. Service and SDK errors continue
 * with hostnames, request paths and response bodies; those stay in the operational log.
 */
export const summaryOf = (error: unknown): string => {
    const line = (errorMessage(error).split(/\r?\n/, 1)[0] ?? '').trim();
    return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
};

export const toLoupeError = (error: unknown): LoupeError => {
    if (isLoupeError(error)) return error;
    return new LoupeError('internal', summaryOf(error), { cause: error });
};
