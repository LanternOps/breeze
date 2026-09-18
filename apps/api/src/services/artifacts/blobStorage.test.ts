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
import type { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_UPLOAD_PART_SIZE,
  ARTIFACT_UPLOAD_QUEUE_SIZE,
  BlobNotFoundError,
  BlobStorageUnavailableError,
  BlobTooLargeError,
  blobKeyFor,
  createMemoryBlobStorage,
  createS3BlobStorage,
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

/**
 * W06 (#5774 decision B): the S3 put streams through `@aws-sdk/lib-storage`'s
 * multipart `Upload`. These tests drive the REAL `Upload` against a hand-rolled
 * client whose `send` records commands, so what is asserted is the wire
 * behaviour — part count, bounded concurrency, and that an over-cap body leaves
 * NO object behind — not a mock of our own helper.
 */
describe('S3 blob storage: streaming multipart put', () => {
  const MiB = 1024 * 1024;

  /** 1 MiB chunks each filled with a distinct byte, so a reordered reassembly is detectable. */
  function deterministicChunks(totalMiB: number): Buffer[] {
    return Array.from({ length: totalMiB }, (_, i) => Buffer.alloc(MiB, (i * 7 + 3) % 251));
  }

  interface FakeS3 {
    client: S3Client;
    commands: { name: string; input: Record<string, unknown> }[];
    objects: Map<string, Buffer>;
    maxPartsInFlight: number;
    partBodies: Buffer[];
    names(): string[];
  }

  function toBuffer(body: unknown): Buffer {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    if (body instanceof Uint8Array) return Buffer.from(body);
    throw new Error(`fake S3 got an unsupported part body: ${typeof body}`);
  }

  function makeFakeS3(failOn?: string): FakeS3 {
    const commands: { name: string; input: Record<string, unknown> }[] = [];
    const objects = new Map<string, Buffer>();
    const parts = new Map<number, Buffer>();
    const partBodies: Buffer[] = [];
    let inFlight = 0;
    const state = { maxPartsInFlight: 0 };

    const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = command.constructor.name;
        commands.push({ name, input: command.input });
        if (failOn === name) {
          throw Object.assign(new Error('provider exploded'), {
            name: 'ServiceUnavailable',
            $metadata: { httpStatusCode: 503 },
          });
        }
        switch (name) {
          case 'CreateMultipartUploadCommand':
            return { UploadId: 'upload-1' };
          case 'UploadPartCommand': {
            inFlight += 1;
            state.maxPartsInFlight = Math.max(state.maxPartsInFlight, inFlight);
            // Hold the part long enough for the queue to saturate, so the
            // in-flight high-water mark is meaningful.
            await new Promise((resolve) => setTimeout(resolve, 5));
            const part = toBuffer(command.input.Body);
            partBodies.push(part);
            parts.set(command.input.PartNumber as number, part);
            inFlight -= 1;
            return { ETag: `"etag-${String(command.input.PartNumber)}"` };
          }
          case 'CompleteMultipartUploadCommand': {
            const ordered = [...parts.keys()].sort((a, b) => a - b).map((n) => parts.get(n)!);
            objects.set(command.input.Key as string, Buffer.concat(ordered));
            return { ETag: '"complete"' };
          }
          case 'AbortMultipartUploadCommand':
            parts.clear();
            objects.delete(command.input.Key as string);
            return {};
          case 'PutObjectCommand':
            objects.set(command.input.Key as string, toBuffer(command.input.Body));
            return { ETag: '"single"' };
          default:
            return {};
        }
      },
      // `Upload.__uploadUsingPut` resolves an endpoint to build the result Location.
      config: {
        forcePathStyle: true,
        endpoint: async () => ({ hostname: 'object-store.test', protocol: 'https:', path: '/' }),
        // `Upload.__createMultipartUpload` reads this as a config PROVIDER.
        requestChecksumCalculation: async () => 'WHEN_SUPPORTED',
      },
    } as unknown as S3Client;

    return {
      client,
      commands,
      objects,
      partBodies,
      get maxPartsInFlight() {
        return state.maxPartsInFlight;
      },
      names: () => commands.map((c) => c.name),
    };
  }

  function withBucket<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.S3_BUCKET;
    process.env.S3_BUCKET = 'breeze-artifacts-test';
    return fn().finally(() => {
      if (prev === undefined) delete process.env.S3_BUCKET;
      else process.env.S3_BUCKET = prev;
    });
  }

  it('streams a multi-part body without ever buffering it whole', async () => {
    const fake = makeFakeS3();
    const chunks = deterministicChunks(20);
    const whole = Buffer.concat(chunks);
    const store = createS3BlobStorage({ clientFor: () => fake.client });

    const put = await withBucket(() =>
      store.put({
        region: 'us',
        contentType: 'application/x-ndjson',
        body: Readable.from(chunks),
        maxBytes: 64 * MiB,
      }),
    );

    // 20 MiB at an 8 MiB part size = 8 + 8 + 4.
    expect(ARTIFACT_UPLOAD_PART_SIZE).toBe(8 * MiB);
    expect(fake.names().filter((n) => n === 'UploadPartCommand')).toHaveLength(3);
    expect(fake.names()).toContain('CreateMultipartUploadCommand');
    expect(fake.names()).toContain('CompleteMultipartUploadCommand');
    expect(fake.names()).not.toContain('AbortMultipartUploadCommand');

    // Residency is bounded by the queue, never by maxBytes. EXACT, not a range:
    // `>= 1` would still pass if queueSize silently collapsed to serial uploads,
    // and `<= queueSize` alone would still pass if it did. The 5 ms hold in the
    // stub guarantees two parts overlap whenever the queue is really 2 deep.
    expect(fake.maxPartsInFlight).toBe(ARTIFACT_UPLOAD_QUEUE_SIZE);
    expect(ARTIFACT_UPLOAD_QUEUE_SIZE).toBeLessThanOrEqual(4);
    for (const part of fake.partBodies) expect(part.length).toBeLessThanOrEqual(ARTIFACT_UPLOAD_PART_SIZE);

    // Compare by digest, never by value: a failed `toEqual` on 20 MiB buffers
    // OOMs the pretty-printer before it can report anything useful.
    const expectedSha = createHash('sha256').update(whole).digest('hex');
    expect(put.bytes).toBe(whole.length);
    expect(put.sha256).toBe(expectedSha);
    const stored = fake.objects.get(put.key);
    expect(stored?.length).toBe(whole.length);
    expect(stored && createHash('sha256').update(stored).digest('hex')).toBe(expectedSha);

    const create = fake.commands.find((c) => c.name === 'CreateMultipartUploadCommand')!;
    expect(create.input.ContentType).toBe('application/x-ndjson');
  });

  it('a single-part body goes through the SAME Upload path (one PutObject, no multipart)', async () => {
    const fake = makeFakeS3();
    const body = Buffer.from('{"rows":[1,2,3]}', 'utf8');
    const store = createS3BlobStorage({ clientFor: () => fake.client });

    const put = await withBucket(() =>
      store.put({ region: 'eu', contentType: 'application/json', body, maxBytes: 1024 }),
    );

    expect(fake.names()).toEqual(['PutObjectCommand']);
    expect(fake.objects.get(put.key)).toEqual(body);
    expect(put.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('forwards ServerSideEncryption when ARTIFACT_S3_SSE is set', async () => {
    const fake = makeFakeS3();
    const prev = process.env.ARTIFACT_S3_SSE;
    process.env.ARTIFACT_S3_SSE = 'AES256';
    try {
      const store = createS3BlobStorage({ clientFor: () => fake.client });
      await withBucket(() =>
        store.put({
          region: 'us',
          contentType: 'text/plain',
          body: Buffer.from('hello'),
          maxBytes: 1024,
        }),
      );
      expect(fake.commands[0]!.input.ServerSideEncryption).toBe('AES256');
    } finally {
      if (prev === undefined) delete process.env.ARTIFACT_S3_SSE;
      else process.env.ARTIFACT_S3_SSE = prev;
    }
  });

  it('ABORTS the multipart upload mid-stream at maxBytes and leaves no object', async () => {
    const fake = makeFakeS3();
    const source = Readable.from(deterministicChunks(30));
    const store = createS3BlobStorage({ clientFor: () => fake.client });

    await expect(
      withBucket(() =>
        store.put({
          region: 'us',
          contentType: 'application/x-ndjson',
          body: source,
          // Several parts in, so a real multipart upload is already open and
          // parts are already on the provider when the cap trips.
          maxBytes: 20 * MiB,
        }),
      ),
    ).rejects.toBeInstanceOf(BlobTooLargeError);

    expect(fake.names()).toContain('CreateMultipartUploadCommand');
    expect(fake.names()).toContain('AbortMultipartUploadCommand');
    expect(fake.names()).not.toContain('CompleteMultipartUploadCommand');
    expect(fake.objects.size).toBe(0);
    expect(source.destroyed).toBe(true);
  });

  it('does not let an abort failure mask the BlobTooLargeError', async () => {
    const fake = makeFakeS3('AbortMultipartUploadCommand');
    const store = createS3BlobStorage({ clientFor: () => fake.client });

    await expect(
      withBucket(() =>
        store.put({
          region: 'us',
          contentType: 'application/x-ndjson',
          body: Readable.from(deterministicChunks(30)),
          maxBytes: 20 * MiB,
        }),
      ),
    ).rejects.toBeInstanceOf(BlobTooLargeError);
    // Not vacuous: the abort really was attempted, and really did fail.
    expect(fake.names()).toContain('AbortMultipartUploadCommand');
  });

  it('refuses an over-cap Buffer before issuing any request', async () => {
    const fake = makeFakeS3();
    const store = createS3BlobStorage({ clientFor: () => fake.client });
    await expect(
      withBucket(() =>
        store.put({
          region: 'us',
          contentType: 'text/plain',
          body: Buffer.alloc(2048),
          maxBytes: 1024,
        }),
      ),
    ).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(fake.commands).toHaveLength(0);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const fake = makeFakeS3();
    const body = Buffer.alloc(1024, 9);
    const store = createS3BlobStorage({ clientFor: () => fake.client });
    const put = await withBucket(() =>
      store.put({ region: 'us', contentType: 'text/plain', body, maxBytes: 1024 }),
    );
    expect(put.bytes).toBe(1024);
    expect(put.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('a NON-cap source fault aborts and surfaces as BlobStorageUnavailableError', async () => {
    const fake = makeFakeS3();
    // The upstream export reader dies mid-stream. This must NOT look like a cap
    // refusal, and must never complete a short object whose sha256 would then
    // describe the truncated bytes and look intact forever.
    let emitted = 0;
    const source = new Readable({
      read() {
        if (emitted >= 12) {
          this.destroy(new Error('export reader failed'));
          return;
        }
        emitted += 1;
        this.push(Buffer.alloc(MiB, emitted % 251));
      },
    });
    const store = createS3BlobStorage({ clientFor: () => fake.client });

    await expect(
      withBucket(() =>
        store.put({
          region: 'us',
          contentType: 'application/x-ndjson',
          body: source,
          maxBytes: 64 * MiB,
        }),
      ),
    ).rejects.toBeInstanceOf(BlobStorageUnavailableError);

    expect(fake.names()).toContain('CreateMultipartUploadCommand');
    expect(fake.names()).toContain('AbortMultipartUploadCommand');
    expect(fake.names()).not.toContain('CompleteMultipartUploadCommand');
    expect(fake.objects.size).toBe(0);
  });

  it('a failing CompleteMultipartUpload is a failure, not a fabricated success', async () => {
    const fake = makeFakeS3('CompleteMultipartUploadCommand');
    const store = createS3BlobStorage({ clientFor: () => fake.client });

    await expect(
      withBucket(() =>
        store.put({
          region: 'us',
          contentType: 'application/x-ndjson',
          body: Readable.from(deterministicChunks(20)),
          maxBytes: 64 * MiB,
        }),
      ),
    ).rejects.toBeInstanceOf(BlobStorageUnavailableError);
    expect(fake.objects.size).toBe(0);
  });

  it('destroys the caller body when the bucket is unconfigured, before any request', async () => {
    const fake = makeFakeS3();
    const source = Readable.from(deterministicChunks(1));
    const prev = process.env.S3_BUCKET;
    delete process.env.S3_BUCKET;
    try {
      const store = createS3BlobStorage({ clientFor: () => fake.client });
      await expect(
        store.put({
          region: 'us',
          contentType: 'text/plain',
          body: source,
          maxBytes: 64 * MiB,
        }),
      ).rejects.toBeInstanceOf(BlobStorageUnavailableError);
    } finally {
      if (prev === undefined) delete process.env.S3_BUCKET;
      else process.env.S3_BUCKET = prev;
    }
    expect(fake.commands).toHaveLength(0);
    expect(source.destroyed).toBe(true);
  });

  it('maps a provider failure to BlobStorageUnavailableError, never a silent fallback', async () => {
    const fake = makeFakeS3('PutObjectCommand');
    const store = createS3BlobStorage({ clientFor: () => fake.client });
    await expect(
      withBucket(() =>
        store.put({
          region: 'us',
          contentType: 'text/plain',
          body: Buffer.from('small'),
          maxBytes: 1024,
        }),
      ),
    ).rejects.toBeInstanceOf(BlobStorageUnavailableError);
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
