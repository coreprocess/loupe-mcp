import type { Request, Response } from 'express';
import { isLoupeError } from '../core/errors.ts';
import type { Loggers } from '../core/logger.ts';
import type { Signer } from '../core/signing.ts';
import { decodeFileName } from '../uploads/names.ts';
import type { UploadService } from '../uploads/uploads.ts';
import { httpStatusOf, sendError } from './responses.ts';

export interface UploadDeps {
    uploads: UploadService;
    signer: Signer;
    loggers: Loggers;
}

/**
 * The upload endpoint (concept §6.5): `PUT /u/<token>/<name>`, one file per request, streamed into
 * the store. Nothing is ever read back under `/u/`.
 */
export const uploadHandler =
    (deps: UploadDeps) =>
    async (req: Request, res: Response): Promise<void> => {
        res.setHeader('Cache-Control', 'no-store');
        // the path as sent, still percent-encoded: `/u/<token>/<name>`
        const [, , token = '', segment, ...rest] = req.path.split('/');
        const payload = deps.signer.verify('upload', token);
        if (!payload) {
            sendError(res, 403, 'forbidden', 'Invalid upload token');
            return;
        }
        if (payload.expires * 1000 < Date.now()) {
            sendError(
                res,
                403,
                'expired',
                'The upload URL expired; call create_upload with the uploadId for a fresh one'
            );
            return;
        }
        if (!segment || rest.length > 0) {
            sendError(res, 400, 'invalid_argument', 'Append one file name to the upload URL: PUT <uploadUrl><name>');
            return;
        }
        const declared = req.headers['content-length'];
        try {
            const name = decodeFileName(segment);
            const file = await deps.uploads.put(
                payload.id,
                name,
                req,
                declared === undefined ? undefined : Number(declared)
            );
            deps.loggers.audit.info(
                {
                    uploadId: payload.id,
                    issuedTo: payload.user,
                    name: file.name,
                    bytes: file.bytes,
                    sha256: file.sha256,
                    type: file.type,
                    client: req.ip,
                },
                'upload'
            );
            res.status(201).json({ name: file.name, bytes: file.bytes, sha256: file.sha256, type: file.type });
        } catch (error) {
            // the rest of a refused body is not read; the connection closes after the answer
            if (!req.complete) res.setHeader('Connection', 'close');
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (isLoupeError(error)) {
                deps.loggers.audit.info(
                    { uploadId: payload.id, issuedTo: payload.user, refused: error.code, client: req.ip },
                    'upload'
                );
                sendError(res, httpStatusOf(error), error.code, error.message);
                return;
            }
            deps.loggers.log.error({ err: error, uploadId: payload.id }, 'upload failed');
            sendError(res, 500, 'internal', 'The upload failed');
        }
    };
