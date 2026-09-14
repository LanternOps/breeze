/**
 * Execution-plane W01 (spec §5.2, §8, §9). The S3 wire path is covered by the
 * ticket-attachment suites; what is unique here and MUST hold is:
 *   - keys carry no tenant identifier and are region/date/uuid shaped,
 *   - `maxBytes` aborts a stream mid-flight rather than buffering past the cap,
 *   - sha256 and byte count are computed from the SAME bytes that were stored,
 *   - delete is idempotent,
 *   - a missing object is BlobNotFoundError, never an empty stream.
 */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlobNotFoundError,
  BlobTooLargeError,
  blobKeyFor,
  createMemoryBlobStorage,
  getBlobStorage,
  setBlobStorageForTests,
} from './blobStorage';

afterEach(() => setBlobStorageForTests(null));

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('blobKeyFor', () => {
  it('is <region>/<yyyy>/<mm>/<uuid> and carries no tenant identifier', () => {
    const key = blobKeyFor('eu', new Date('2026-10-16T12:00:00Z'));
    expect(key).toMatch(/^eu\/2026\/10\/[0-9a-f-]{36}$/);
  });

  it('zero-pads the month', () => {
    expect(blobKeyFor('us', new Date('2026-03-04T00:00:00Z')).startsWith('us/2026/03/')).toBe(true);
  });

  it('never repeats a key', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    expect(blobKeyFor('us', now)).not.toBe(blobKeyFor('us', now));
  });
});

describe('memory blob storage (the test double every other suite injects)', () => {
  it('round-trips a buffer and reports bytes + sha256 of the stored bytes', async () => {
    const store = createMemoryBlobStorage();
    const body = Buffer.from('{"rows":[1,2,3]}', 'utf8');
    const put = await store.put({ region: 'us', contentType: 'application/json', body, maxBytes: 1024 });
    expect(put.bytes).toBe(body.length);
    expect(put.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(await drain(await store.openStream(put.key))).toEqual(body);
  });

  it('accepts a readable stream and hashes what it actually read', async () => {
    const store = createMemoryBlobStorage();
    const body = Buffer.from('a'.repeat(5000), 'utf8');
    const put = await store.put({
      region: 'eu',
      contentType: 'text/plain; charset=utf-8',
      body: Readable.from([body.subarray(0, 2000), body.subarray(2000)]),
      maxBytes: 10_000,
    });
    expect(put.bytes).toBe(5000);
    expect(put.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('throws BlobTooLargeError and stores NOTHING when the body exceeds maxBytes', async () => {
    const store = createMemoryBlobStorage();
    await expect(
      store.put({
        region: 'us',
        contentType: 'text/plain',
        body: Readable.from([Buffer.alloc(600), Buffer.alloc(600)]),
        maxBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(store.objects.size).toBe(0);
  });

  it('throws BlobNotFoundError for an unknown key and delete is idempotent', async () => {
    const store = createMemoryBlobStorage();
    await expect(store.openStream('us/2026/10/missing')).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.delete('us/2026/10/missing');
    await store.delete('us/2026/10/missing');
  });
});

describe('getBlobStorage()', () => {
  it('returns the injected double while one is set, and forgets it afterwards', () => {
    const store = createMemoryBlobStorage();
    setBlobStorageForTests(store);
    expect(getBlobStorage()).toBe(store);
    setBlobStorageForTests(null);
    expect(getBlobStorage()).not.toBe(store);
  });

  it('refuses ARTIFACT_BLOB_BACKEND=db — there is no generic blob table in v1', () => {
    const prev = process.env.ARTIFACT_BLOB_BACKEND;
    process.env.ARTIFACT_BLOB_BACKEND = 'db';
    try {
      expect(() => getBlobStorage()).toThrowError(/ARTIFACT_BLOB_BACKEND=db/);
    } finally {
      if (prev === undefined) delete process.env.ARTIFACT_BLOB_BACKEND;
      else process.env.ARTIFACT_BLOB_BACKEND = prev;
    }
  });
});
