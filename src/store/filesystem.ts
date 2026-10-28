import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LoupeError } from '../core/errors.ts';
import type { Store, StoredObjectInfo } from './store.ts';

/**
 * The store on the local filesystem (stdio mode, tests). One process owns it, so leases are held in
 * memory.
 */
export class FilesystemStore implements Store {
    readonly kind = 'filesystem' as const;
    readonly #root: string;
    readonly #leases = new Map<string, { id: string; seconds: number; expiresAt: number }>();

    constructor(root: string) {
        this.#root = resolve(root);
    }

    async init(): Promise<void> {
        await mkdir(this.#root, { recursive: true });
    }

    #path(path: string): string {
        const full = resolve(this.#root, path);
        if (!full.startsWith(this.#root + sep)) throw new LoupeError('invalid_argument', 'Path escapes the store root');
        return full;
    }

    #temp(full: string): string {
        return `${full}.${randomUUID()}.tmp`;
    }

    async put(path: string, body: Buffer | string): Promise<void> {
        const full = this.#path(path);
        await mkdir(dirname(full), { recursive: true });
        const temp = this.#temp(full);
        await writeFile(temp, body);
        await rename(temp, full);
    }

    async create(path: string, body: Readable): Promise<void> {
        const full = this.#path(path);
        await mkdir(dirname(full), { recursive: true });
        const temp = this.#temp(full);
        try {
            await pipeline(body, createWriteStream(temp));
            // link() refuses an existing target atomically: of two concurrent creates exactly one succeeds
            await link(temp, full).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'EEXIST') throw new LoupeError('conflict', 'The object exists already');
                throw error;
            });
        } finally {
            await rm(temp, { force: true });
        }
    }

    async get(path: string): Promise<Buffer | undefined> {
        try {
            return await readFile(this.#path(path));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async getRange(path: string, offset: number, length: number): Promise<Buffer> {
        const handle = await open(this.#path(path), 'r').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') throw new LoupeError('not_found', `Not found: ${path}`);
            throw error;
        });
        try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    }

    async head(path: string): Promise<StoredObjectInfo | undefined> {
        try {
            const info = await stat(this.#path(path));
            return {
                size: info.size,
                etag: `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
                lastModified: info.mtime,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async stream(path: string, range?: { offset: number; length: number }): Promise<Readable> {
        const full = this.#path(path);
        await stat(full).catch(() => {
            throw new LoupeError('not_found', `Not found: ${path}`);
        });
        if (!range) return createReadStream(full);
        if (range.length === 0) return createReadStream(full, { start: 1, end: 0 });
        return createReadStream(full, { start: range.offset, end: range.offset + range.length - 1 });
    }

    async *list(prefix: string): AsyncIterable<string> {
        const paths: string[] = [];
        const walk = async (directory: string): Promise<void> => {
            const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                const full = join(directory, entry.name);
                if (entry.isDirectory()) await walk(full);
                else if (!entry.name.endsWith('.tmp')) paths.push(relative(this.#root, full).split(sep).join('/'));
            }
        };
        await walk(this.#path(prefix));
        yield* paths.sort();
    }

    async delete(path: string): Promise<void> {
        await unlink(this.#path(path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });
        this.#leases.delete(path);
    }

    async deletePrefix(prefix: string): Promise<void> {
        await rm(this.#path(prefix), { recursive: true, force: true });
    }

    async acquireLease(path: string, seconds: number): Promise<string | undefined> {
        if (!(await this.head(path))) return undefined;
        const held = this.#leases.get(path);
        if (held && held.expiresAt > Date.now()) return undefined;
        const id = randomUUID();
        this.#leases.set(path, { id, seconds, expiresAt: Date.now() + seconds * 1000 });
        return id;
    }

    async renewLease(path: string, leaseId: string): Promise<boolean> {
        const held = this.#leases.get(path);
        if (held?.id !== leaseId || !(await this.head(path))) return false;
        held.expiresAt = Date.now() + held.seconds * 1000;
        return true;
    }

    async releaseLease(path: string, leaseId: string): Promise<void> {
        if (this.#leases.get(path)?.id === leaseId) this.#leases.delete(path);
    }

    async deleteLeased(path: string, leaseId: string): Promise<void> {
        if (this.#leases.get(path)?.id !== leaseId) throw new LoupeError('conflict', 'The lease is not held');
        await this.delete(path);
    }
}
