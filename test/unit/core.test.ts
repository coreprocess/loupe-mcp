import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseIsoDuration } from '../../src/core/duration.ts';
import { LoupeError } from '../../src/core/errors.ts';
import { isId, newId } from '../../src/core/ids.ts';
import { Semaphore } from '../../src/core/semaphore.ts';
import { Signer } from '../../src/core/signing.ts';
import { includesPage, parsePageSelection, selectPages, toPageSpec } from '../../src/reading/pages.ts';
import { decodeFileName } from '../../src/uploads/names.ts';

const isInvalid = (error: unknown) => error instanceof LoupeError && error.code === 'invalid_argument';

describe('signed URL tokens', () => {
    const signer = new Signer(Buffer.alloc(32, 7));
    const payload = { id: 'u_abc', user: 'user-1', expires: 2_000_000_000 };

    it('round-trips a payload for its purpose', () => {
        assert.deepEqual(signer.verify('upload', signer.sign('upload', payload)), payload);
    });

    it('never verifies a token for the other purpose', () => {
        assert.equal(signer.verify('download', signer.sign('upload', payload)), undefined);
        assert.equal(signer.verify('upload', signer.sign('download', payload)), undefined);
    });

    it('rejects tampered tokens and other keys', () => {
        const token = signer.sign('download', payload);
        const [body, mac] = token.split('.') as [string, string];
        const forged = Buffer.from(JSON.stringify({ i: 'j_other', u: 'user-1', e: 2_000_000_000 })).toString(
            'base64url'
        );
        assert.equal(signer.verify('download', `${forged}.${mac}`), undefined);
        assert.equal(signer.verify('download', `${body}.${mac.slice(1)}`), undefined);
        assert.equal(signer.verify('download', `${body}`), undefined);
        assert.equal(new Signer(Buffer.alloc(32, 8)).verify('download', token), undefined);
    });
});

describe('ids and durations', () => {
    it('creates unguessable ids per kind', () => {
        const id = newId('job');
        assert.ok(isId('job', id));
        assert.ok(!isId('upload', id));
        assert.notEqual(newId('job'), id);
    });

    it('parses ISO 8601 durations', () => {
        assert.equal(parseIsoDuration('P2D'), 172_800_000);
        assert.equal(parseIsoDuration('PT1H30M'), 5_400_000);
        assert.throws(() => parseIsoDuration('2 days'));
    });
});

describe('semaphore', () => {
    it('runs at most the given number of tasks at once', async () => {
        const slots = new Semaphore(2);
        let running = 0;
        let peak = 0;
        await Promise.all(
            Array.from({ length: 6 }, () =>
                slots.run(async () => {
                    peak = Math.max(peak, ++running);
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    running--;
                })
            )
        );
        assert.equal(peak, 2);
    });
});

describe('page selections', () => {
    it('parses, selects and compacts pages', () => {
        const ranges = parsePageSelection('1-3, 7,9-10');
        assert.deepEqual(selectPages(ranges, 9), [1, 2, 3, 7, 9]);
        assert.deepEqual(selectPages(undefined, 3), [1, 2, 3]);
        assert.equal(toPageSpec([1, 2, 3, 7, 9, 10]), '1-3,7,9-10');
        assert.ok(includesPage(ranges, 2) && !includesPage(ranges, 4));
    });

    it('refuses malformed selections', () => {
        for (const spec of ['', '0', '3-1', 'a', '1,,2', '1-', '200000'])
            assert.throws(() => parsePageSelection(spec), isInvalid);
    });
});

describe('upload file names', () => {
    it('decodes percent-encoded UTF-8', () => {
        assert.equal(decodeFileName('Scan%20M%C3%BCller%2001.pdf'), 'Scan Müller 01.pdf');
    });

    it('refuses names that could escape or confuse', () => {
        for (const segment of ['', '.', '..', 'a%2Fb', 'a%5Cb', 'a%00b', 'a%0Ab', '%E2%82', 'x'.repeat(256)]) {
            assert.throws(() => decodeFileName(segment), isInvalid, segment);
        }
        assert.equal(decodeFileName('x'.repeat(255)).length, 255);
    });
});
