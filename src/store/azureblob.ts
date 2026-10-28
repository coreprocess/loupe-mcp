import type { Readable } from 'node:stream';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient, RestError } from '@azure/storage-blob';
import { LoupeError } from '../core/errors.ts';
import type { Store, StoredObjectInfo } from './store.ts';

const UPLOAD_BLOCK_BYTES = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 2;

const statusOf = (error: unknown): number | undefined => (error instanceof RestError ? error.statusCode : undefined);

/** The store on Azure Blob Storage: Loupe's own container, written with its managed identity. */
export class AzureBlobStore implements Store {
    readonly kind = 'azureblob' as const;
    readonly #container: ContainerClient;

    constructor(options: {
        accountUrl?: string | undefined;
        connectionString?: string | undefined;
        container: string;
    }) {
        const service = options.connectionString
            ? BlobServiceClient.fromConnectionString(options.connectionString)
            : new BlobServiceClient(options.accountUrl as string, new DefaultAzureCredential());
        this.#container = service.getContainerClient(options.container);
    }

    async init(): Promise<void> {
        // the container belongs to the deployment, which creates it with the storage account
    }

    async put(path: string, body: Buffer | string, contentType: string): Promise<void> {
        const data = typeof body === 'string' ? Buffer.from(body) : body;
        await this.#container.getBlockBlobClient(path).uploadData(data, {
            blobHTTPHeaders: { blobContentType: contentType },
        });
    }

    async create(path: string, body: Readable, contentType: string): Promise<void> {
        try {
            await this.#container.getBlockBlobClient(path).uploadStream(body, UPLOAD_BLOCK_BYTES, UPLOAD_CONCURRENCY, {
                blobHTTPHeaders: { blobContentType: contentType },
                conditions: { ifNoneMatch: '*' },
            });
        } catch (error) {
            if (statusOf(error) === 409 || statusOf(error) === 412) {
                throw new LoupeError('conflict', 'The object exists already');
            }
            throw error;
        }
    }

    async get(path: string): Promise<Buffer | undefined> {
        try {
            return await this.#container.getBlobClient(path).downloadToBuffer();
        } catch (error) {
            if (statusOf(error) === 404) return undefined;
            throw error;
        }
    }

    async getRange(path: string, offset: number, length: number): Promise<Buffer> {
        if (length === 0) return Buffer.alloc(0);
        try {
            return await this.#container.getBlobClient(path).downloadToBuffer(offset, length, { concurrency: 1 });
        } catch (error) {
            if (statusOf(error) === 404) throw new LoupeError('not_found', `Not found: ${path}`);
            throw error;
        }
    }

    async head(path: string): Promise<StoredObjectInfo | undefined> {
        try {
            const props = await this.#container.getBlobClient(path).getProperties();
            return {
                size: props.contentLength ?? 0,
                etag: props.etag ?? '',
                lastModified: props.lastModified ?? new Date(0),
            };
        } catch (error) {
            if (statusOf(error) === 404) return undefined;
            throw error;
        }
    }

    async stream(path: string, range?: { offset: number; length: number }): Promise<Readable> {
        try {
            const response = await this.#container
                .getBlobClient(path)
                .download(range?.offset ?? 0, range ? Math.max(range.length, 1) : undefined);
            if (!response.readableStreamBody) throw new LoupeError('internal', 'Empty download stream');
            return response.readableStreamBody as Readable;
        } catch (error) {
            if (statusOf(error) === 404) throw new LoupeError('not_found', `Not found: ${path}`);
            throw error;
        }
    }

    async *list(prefix: string): AsyncIterable<string> {
        for await (const blob of this.#container.listBlobsFlat({ prefix })) yield blob.name;
    }

    async delete(path: string): Promise<void> {
        await this.#container.deleteBlob(path, { deleteSnapshots: 'include' }).catch((error: unknown) => {
            if (statusOf(error) !== 404) throw error;
        });
    }

    async deletePrefix(prefix: string): Promise<void> {
        for await (const path of this.list(prefix)) await this.delete(path);
    }

    async acquireLease(path: string, seconds: number): Promise<string | undefined> {
        try {
            const lease = await this.#container.getBlobClient(path).getBlobLeaseClient().acquireLease(seconds);
            return lease.leaseId;
        } catch (error) {
            if (statusOf(error) === 409 || statusOf(error) === 404) return undefined;
            throw error;
        }
    }

    async renewLease(path: string, leaseId: string): Promise<boolean> {
        try {
            await this.#container.getBlobClient(path).getBlobLeaseClient(leaseId).renewLease();
            return true;
        } catch (error) {
            const status = statusOf(error);
            if (status === 409 || status === 412 || status === 404) return false;
            throw error;
        }
    }

    async releaseLease(path: string, leaseId: string): Promise<void> {
        await this.#container
            .getBlobClient(path)
            .getBlobLeaseClient(leaseId)
            .releaseLease()
            .catch(() => undefined);
    }

    async deleteLeased(path: string, leaseId: string): Promise<void> {
        await this.#container.deleteBlob(path, { conditions: { leaseId } }).catch((error: unknown) => {
            if (statusOf(error) !== 404) throw error;
        });
    }
}
