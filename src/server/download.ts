import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { isLoupeError } from '../core/errors.ts';
import type { Loggers } from '../core/logger.ts';
import type { Signer } from '../core/signing.ts';
import { extensionOf, resultPath } from '../jobs/results.ts';
import type { JobService } from '../jobs/service.ts';
import { paths } from '../store/paths.ts';
import type { Store } from '../store/store.ts';
import { httpStatusOf, sendError } from './responses.ts';

/**
 * The download endpoint (concept §6.6): `GET|HEAD /r/<token>/<path>`. Files are served exactly as
 * stored with strong ETags and single-range support; nothing is compressed in transit. Only the
 * manifest and the result files are reachable.
 */

interface ByteRange {
    start: number;
    end: number;
}

/** Parses a single `bytes=` range. Returns 'unsatisfiable', or undefined to serve the whole file. */
export const parseRange = (header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined => {
    if (!header) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return undefined;
    const [, from, to] = match;
    if (from === '' && to === '') return undefined;
    let start: number;
    let end: number;
    if (from === '') {
        const suffix = Number(to);
        if (suffix === 0) return 'unsatisfiable';
        start = Math.max(size - suffix, 0);
        end = size - 1;
    } else {
        start = Number(from);
        end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
    }
    if (start >= size || start > end) return 'unsatisfiable';
    return { start, end };
};

/** RFC 6266: an ASCII `filename` for old clients and the exact name as UTF-8 in `filename*`. */
const contentDisposition = (name: string): string => {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(name).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

export interface DownloadDeps {
    store: Store;
    jobs: JobService;
    signer: Signer;
    loggers: Loggers;
}

export const downloadHandler =
    (deps: DownloadDeps) =>
    async (req: Request, res: Response): Promise<void> => {
        const [, , token = '', ...rest] = req.path.split('/');
        const relative = rest.join('/');
        const payload = deps.signer.verify('download', token);
        if (!payload) {
            sendError(res, 403, 'forbidden', 'Invalid download token');
            return;
        }
        if (payload.expires * 1000 < Date.now()) {
            sendError(res, 403, 'expired', 'The download URL expired; call get_job for a fresh one');
            return;
        }
        res.setHeader('Cache-Control', 'private, no-store, no-transform');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            const { job, state, status } = await deps.jobs.snapshot(payload.id);
            if (status === 'expired') {
                sendError(res, 410, 'expired', 'The job expired');
                return;
            }
            let path: string;
            let contentType: string;
            let fileName: string;
            if (relative === 'manifest.json') {
                path = paths.manifest(job.jobId);
                contentType = 'application/json';
                fileName = 'manifest.json';
            } else {
                const index = job.files.findIndex((file, i) => {
                    const document = state.documents[i];
                    return (
                        document?.status === 'succeeded' &&
                        document.format &&
                        resultPath(file.name, document.format) === relative
                    );
                });
                const document = state.documents[index];
                const file = job.files[index];
                if (!document?.format || !file) {
                    sendError(res, 404, 'not_found', 'File not found');
                    return;
                }
                path = paths.result(job.jobId, index, extensionOf(document.format));
                contentType =
                    document.format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
                fileName = `${file.name}.${extensionOf(document.format)}`;
                // a transcript opened in a browser runs nothing
                if (document.format === 'html') res.setHeader('Content-Security-Policy', 'sandbox');
            }
            const info = await deps.store.head(path);
            if (!info) {
                sendError(res, 404, 'not_found', 'File not found');
                return;
            }
            const size = info.size;
            const etag = info.etag.startsWith('"') ? info.etag : `"${info.etag}"`;
            res.setHeader('ETag', etag);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', contentDisposition(fileName));
            if (req.headers['if-none-match'] === etag) {
                res.status(304).end();
                return;
            }
            const ifRange = req.headers['if-range'];
            const range = ifRange && ifRange !== etag ? undefined : parseRange(req.headers.range, size);
            if (range === 'unsatisfiable') {
                res.setHeader('Content-Range', `bytes */${size}`);
                res.status(416).end();
                return;
            }
            if (range) {
                res.status(206);
                res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
                res.setHeader('Content-Length', String(range.end - range.start + 1));
            } else {
                res.status(200);
                res.setHeader('Content-Length', String(size));
            }
            deps.loggers.audit.info(
                {
                    jobId: job.jobId,
                    issuedTo: payload.user,
                    path: relative,
                    bytes: range ? range.end - range.start + 1 : size,
                    range: req.headers.range ?? null,
                    client: req.ip,
                },
                'download'
            );
            if (req.method === 'HEAD' || size === 0) {
                res.end();
                return;
            }
            const stream: Readable = await deps.store.stream(
                path,
                range ? { offset: range.start, length: range.end - range.start + 1 } : undefined
            );
            await pipeline(stream, res);
        } catch (error) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (isLoupeError(error)) {
                sendError(res, httpStatusOf(error), error.code, error.message);
                return;
            }
            deps.loggers.log.error({ err: error, jobId: payload.id }, 'download failed');
            sendError(res, 500, 'internal', 'The download failed');
        }
    };
