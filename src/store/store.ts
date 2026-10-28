import type { Readable } from 'node:stream';

/**
 * Loupe's own storage: uploads, job state and results (concept §6.3). Paths are relative to the
 * store root and use `/` as separator. Implementations: local filesystem and Azure Blob Storage.
 */
export interface StoredObjectInfo {
    size: number;
    etag: string;
    lastModified: Date;
}

export interface Store {
    readonly kind: 'filesystem' | 'azureblob';
    init(): Promise<void>;
    put(path: string, body: Buffer | string, contentType: string): Promise<void>;
    /**
     * Streams a body into a new object. Fails with `conflict` when the object exists already; when the
     * body fails, nothing becomes visible.
     */
    create(path: string, body: Readable, contentType: string): Promise<void>;
    get(path: string): Promise<Buffer | undefined>;
    getRange(path: string, offset: number, length: number): Promise<Buffer>;
    head(path: string): Promise<StoredObjectInfo | undefined>;
    stream(path: string, range?: { offset: number; length: number }): Promise<Readable>;
    /** The paths under a prefix ending in `/`, at any depth, in lexicographic order. */
    list(prefix: string): AsyncIterable<string>;
    /** Deletes the object; a missing one is no error. */
    delete(path: string): Promise<void>;
    deletePrefix(prefix: string): Promise<void>;
    /** Takes a lease on an existing object; undefined when another holder has it or the object is gone. */
    acquireLease(path: string, seconds: number): Promise<string | undefined>;
    /** Extends the lease; false when it was lost. */
    renewLease(path: string, leaseId: string): Promise<boolean>;
    releaseLease(path: string, leaseId: string): Promise<void>;
    /** Deletes an object this holder has leased. */
    deleteLeased(path: string, leaseId: string): Promise<void>;
}

export const getJson = async <T>(store: Store, path: string): Promise<T | undefined> => {
    const data = await store.get(path);
    return data === undefined ? undefined : (JSON.parse(data.toString('utf8')) as T);
};

export const putJson = (store: Store, path: string, value: unknown): Promise<void> =>
    store.put(path, `${JSON.stringify(value, null, 1)}\n`, 'application/json');
