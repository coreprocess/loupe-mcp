import type { Response } from 'express';
import type { LoupeError } from '../core/errors.ts';

/** The HTTP status of an error on the data plane (concept §6.5, §6.6). */
export const httpStatusOf = (error: LoupeError): number => {
    switch (error.code) {
        case 'invalid_argument':
            return 400;
        case 'unauthorized':
        case 'forbidden':
            return 403;
        case 'not_found':
            return 404;
        case 'conflict':
            return 409;
        case 'expired':
            return 410;
        case 'too_large':
        case 'limit_exceeded':
            return 413;
        case 'unsupported_type':
            return 415;
        default:
            return 500;
    }
};

export const sendError = (res: Response, status: number, code: string, message: string): void => {
    res.status(status)
        .type('application/json')
        .send(`${JSON.stringify({ error: { code, message } })}\n`);
};
