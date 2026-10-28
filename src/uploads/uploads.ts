import { createHash } from 'node:crypto';
import { type Readable, Transform } from 'node:stream';
import type { LimitsConfig } from '../config/env.ts';
import { LoupeError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import type { Caller, UploadedFile, UploadRecord } from '../jobs/model.ts';
import { fileKey, paths } from '../store/paths.ts';
import { getJson, putJson, type Store } from '../store/store.ts';
import { detectType } from './detect.ts';
import { checkFileName } from './names.ts';
import { DOCUMENT_TYPES } from './types.ts';

/** Every accepted type, as `create_upload` reports it. */
export const ACCEPTED_TYPES = Object.values(DOCUMENT_TYPES);

/**
 * Uploads (concept §5.1, §6.5): an upload is a set of write-once files. A file is accepted only once
 * its bytes are stored and its type is detected; until then it is not part of the upload.
 */
export class UploadService {
    readonly #store: Store;
    readonly #limits: LimitsConfig;
    readonly #retentionMs: number;

    constructor(store: Store, limits: LimitsConfig, retentionMs: number) {
        this.#store = store;
        this.#limits = limits;
        this.#retentionMs = retentionMs;
    }

    async create(caller: Caller): Promise<UploadRecord> {
        const now = Date.now();
        const record: UploadRecord = {
            uploadId: newId('upload'),
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + this.#retentionMs).toISOString(),
            createdBy: caller.oid,
        };
        await putJson(this.#store, paths.upload(record.uploadId), record);
        return record;
    }

    /** The upload; `not_found` when it does not exist, `expired` once its retention has passed. */
    async get(uploadId: string): Promise<UploadRecord> {
        const record = await getJson<UploadRecord>(this.#store, paths.upload(uploadId));
        if (!record) throw new LoupeError('not_found', `Unknown upload '${uploadId}'`);
        if (Date.now() > Date.parse(record.expiresAt)) throw new LoupeError('expired', `Upload '${uploadId}' expired`);
        return record;
    }

    /** The accepted files, in the order they arrived. */
    async files(uploadId: string): Promise<UploadedFile[]> {
        const files: UploadedFile[] = [];
        for await (const { path } of this.#store.list(paths.acceptedPrefix(uploadId))) {
            const file = await getJson<UploadedFile>(this.#store, path);
            if (file) files.push(file);
        }
        return files.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.name.localeCompare(b.name));
    }

    /**
     * Stores one file: write-once, within the limits, of an accepted type. Throws `conflict` for a name
     * the upload has already, `limit_exceeded` or `too_large` beyond the limits, and `unsupported_type`.
     */
    async put(
        uploadId: string,
        name: string,
        body: Readable,
        declaredLength: number | undefined
    ): Promise<UploadedFile> {
        checkFileName(name);
        await this.get(uploadId);
        const key = fileKey(name);
        const filePath = paths.uploadFile(uploadId, key);
        if (await this.#store.head(filePath))
            throw new LoupeError('conflict', `The upload has a file '${name}' already`);

        // the stored files, as one listing: a file being uploaded right now counts as well
        let count = 0;
        let used = 0;
        for await (const { size } of this.#store.list(paths.uploadFilesPrefix(uploadId))) {
            count++;
            used += size;
        }
        if (count >= this.#limits.uploadMaxFiles) {
            throw new LoupeError(
                'limit_exceeded',
                `The upload holds the maximum of ${this.#limits.uploadMaxFiles} files`
            );
        }
        const allowed = Math.min(this.#limits.maxFileBytes, this.#limits.uploadMaxBytes - used);
        if (allowed <= 0) {
            throw new LoupeError(
                'limit_exceeded',
                `The upload holds the maximum of ${this.#limits.uploadMaxBytes} bytes`
            );
        }
        const tooLarge = () =>
            new LoupeError(
                'too_large',
                allowed < this.#limits.maxFileBytes
                    ? `The file exceeds the ${allowed} bytes left in the upload`
                    : `The file exceeds the limit of ${allowed} bytes`
            );
        if (declaredLength !== undefined && declaredLength > allowed) throw tooLarge();

        // counted and hashed on the way in; the store commits nothing when the stream fails
        const hash = createHash('sha256');
        let bytes = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                if (bytes > allowed) {
                    done(tooLarge());
                    return;
                }
                hash.update(chunk);
                done(null, chunk);
            },
        });
        body.on('error', (error) => meter.destroy(error));
        // the store's pipeline reports the error; it may arise before the store has attached it
        meter.on('error', () => undefined);
        body.pipe(meter);
        await this.#store.create(filePath, meter, 'application/octet-stream');

        const type = await detectType((offset, length) => this.#store.getRange(filePath, offset, length), bytes);
        if (!type) {
            await this.#store.delete(filePath);
            throw new LoupeError(
                'unsupported_type',
                `'${name}' is no accepted type (PDF, JPEG, PNG, BMP, TIFF, HEIC/HEIF, DOCX, DOCM, XLSX, PPTX, HTML)`
            );
        }
        const file: UploadedFile = {
            name,
            key,
            type,
            bytes,
            sha256: hash.digest('hex'),
            uploadedAt: new Date().toISOString(),
        };
        await putJson(this.#store, paths.accepted(uploadId, key), file);
        return file;
    }
}
