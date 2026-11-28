/**
 * S3-compatibility smoke test against a REAL object store (#8350).
 *
 * Drives the storage calls Breeze actually makes, through Breeze's own
 * services, against whatever S3-compatible store `S3_ENDPOINT` names. CI runs
 * it against the digest-pinned RustFS the dev stack bundles
 * (vitest.config.storage.ts, `test:storage`).
 *
 * Two client paths are covered, because they are built differently:
 * - platform storage (s3Storage.ts, artifacts/blobStorage.ts), configured from
 *   `S3_*` env;
 * - backup destinations (backupStoragePresign.ts), configured per tenant and
 *   built through the SSRF guard (guardedS3Client.ts). The guard always
 *   refuses loopback, so `S3_ENDPOINT` must be a non-loopback private address
 *   (the store's Docker bridge IP), exactly like a self-hosted LAN store.
 *
 * Each run creates its own random bucket and removes it afterwards, pass or
 * fail. Missing configuration fails the suite; it is never skipped.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  __resetS3ClientForTests,
  deleteObjects,
  getObjectStream,
  getPresignedUrl,
  putObjectBuffer,
  uploadBinary,
} from './s3Storage';
import { BlobNotFoundError, createS3BlobStorage, resetBlobClientsForTests } from './artifacts/blobStorage';
import {
  ObjectExistsError,
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteKeys,
  listKeysUnderPrefix,
  listMultipartUploads,
  presignPutObject,
  presignUploadPart,
  probeConditionalWrites,
  type PresignedWrite,
} from './backupStoragePresign';

const MiB = 1024 * 1024;
const NO_SSE = { mode: 'disabled' } as const;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for test:storage (see vitest.config.storage.ts)`);
  return value;
}

const endpoint = requiredEnv('S3_ENDPOINT');
const accessKey = requiredEnv('S3_ACCESS_KEY');
const secretKey = requiredEnv('S3_SECRET_KEY');
const region = process.env.S3_REGION?.trim() || 'us-east-1';
const bucket = `breeze-s3compat-${randomUUID().slice(0, 8)}`;
const backupCfg = { bucket, endpoint, region, accessKey, secretKey };

const admin = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function readAll(stream: Readable | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

async function getBytes(key: string): Promise<Buffer> {
  const res = await admin.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

/** Sends a presigned write the way a device does: exactly the returned headers, plus the body. */
async function sendPresigned(write: PresignedWrite, body: Buffer): Promise<Response> {
  // fetch derives Content-Length from the body itself (it may not be set by hand).
  const { 'content-length': _length, ...headers } = write.headers;
  return fetch(write.url, { method: 'PUT', headers, body: new Uint8Array(body) });
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

async function emptyBucket(): Promise<void> {
  const uploads = await admin.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
  for (const u of uploads.Uploads ?? []) {
    await admin.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key!, UploadId: u.UploadId! }));
  }
  let token: string | undefined;
  do {
    const page = await admin.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) await admin.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

async function countUnder(prefix: string): Promise<number> {
  const res = await admin.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return res.KeyCount ?? 0;
}

beforeAll(async () => {
  if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(endpoint)) {
    throw new Error('S3_ENDPOINT must not be loopback: the backup SSRF guard refuses it. Use the store container IP.');
  }
  process.env.S3_BUCKET = bucket;
  __resetS3ClientForTests();
  resetBlobClientsForTests();
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
});

afterAll(async () => {
  try {
    await emptyBucket();
    await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
  } finally {
    admin.destroy();
  }
});

describe('platform storage (s3Storage.ts, env-configured)', () => {
  it('round-trips a buffer byte-for-byte and reports a missing key as absent', async () => {
    const body = randomBytes(64 * 1024);
    await putObjectBuffer('platform/buffer.bin', body, 'image/png', sha256(body));

    const { body: stream, contentLength } = await getObjectStream('platform/buffer.bin');
    expect(contentLength).toBe(body.length);
    expect((await readAll(stream!)).equals(body)).toBe(true);

    const head = await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: 'platform/buffer.bin' }));
    expect(head.ContentType).toBe('image/png');
    expect(head.Metadata?.sha256).toBe(sha256(body));

    expect((await getObjectStream('platform/missing.bin')).body).toBeNull();
  });

  it('uploads a file and serves it through a presigned GET', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breeze-s3compat-'));
    try {
      const body = randomBytes(256 * 1024);
      const path = join(dir, 'agent.bin');
      await writeFile(path, body);
      await uploadBinary(path, 'platform/agent.bin', sha256(body));

      const res = await fetch(await getPresignedUrl('platform/agent.bin', 60));
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);

      await expect(getPresignedUrl('platform/missing.bin', 60)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('batch-deletes keys, and re-deleting already-deleted keys still succeeds', async () => {
    const keys = ['platform/del/a', 'platform/del/b', 'platform/del/c'];
    for (const key of keys) await admin.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: key }));

    await deleteObjects(keys);
    expect(await countUnder('platform/del/')).toBe(0);
    // Org erasure reruns deleteObjects over keys that may already be gone.
    await expect(deleteObjects(keys)).resolves.toBeUndefined();
  });
});

describe('artifact storage (blobStorage.ts, managed multipart + ranges)', () => {
  const blobs = createS3BlobStorage();

  it('streams a multipart upload and reads back exact bytes and ranges', async () => {
    const body = randomBytes(20 * MiB); // three parts at the 8 MiB part size
    const put = await blobs.put({ region: 'us', contentType: 'application/json', body, maxBytes: 32 * MiB });
    expect(put.bytes).toBe(body.length);
    expect(put.sha256).toBe(sha256(body));

    expect((await readAll(await blobs.openStream(put.key))).equals(body)).toBe(true);
    for (const [start, end] of [[0, 0], [100, 8 * MiB + 99], [body.length - 10, body.length - 1]] as const) {
      const slice = await readAll(await blobs.openRange(put.key, start, end));
      expect(slice.equals(body.subarray(start, end + 1))).toBe(true);
    }

    await blobs.delete(put.key);
    await expect(blobs.openStream(put.key)).rejects.toBeInstanceOf(BlobNotFoundError);
    // A completed upload must leave no unfinished multipart uploads behind.
    expect((await admin.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads ?? []).toHaveLength(0);
  });
});

describe('backup destination storage (backupStoragePresign.ts, SSRF-guarded client)', () => {
  it('enforces create-only writes (capability probe)', async () => {
    await expect(probeConditionalWrites(backupCfg)).resolves.toEqual({ supported: true, reason: 'precondition_enforced' });
  });

  it('accepts a presigned create-only PUT once and refuses a second one with 412', async () => {
    const key = 'backup/put/object.bin';
    const body = randomBytes(128 * 1024);
    const first = await presignPutObject(backupCfg, key, body.length, NO_SSE, { expiresInSeconds: 60, ifNoneMatch: true });
    expect((await sendPresigned(first, body)).status).toBe(200);

    const other = randomBytes(body.length);
    const second = await presignPutObject(backupCfg, key, other.length, NO_SSE, { expiresInSeconds: 60, ifNoneMatch: true });
    expect((await sendPresigned(second, other)).status).toBe(412);
    expect((await getBytes(key)).equals(body)).toBe(true);
  });

  it('lets exactly one of several concurrent create-only PUTs win, without overwrite', async () => {
    const key = 'backup/race/object.bin';
    const bodies = Array.from({ length: 5 }, () => randomBytes(32 * 1024));
    const writes = await Promise.all(bodies.map((b) =>
      presignPutObject(backupCfg, key, b.length, NO_SSE, { expiresInSeconds: 60, ifNoneMatch: true })));
    const statuses = await Promise.all(writes.map((w, i) => sendPresigned(w, bodies[i]!).then((r) => r.status)));

    const winners = statuses.flatMap((s, i) => (s === 200 ? [i] : []));
    expect(winners).toHaveLength(1);
    // AWS documents 409 ConditionalRequestConflict for an in-flight race; 412 otherwise.
    for (const s of statuses.filter((s) => s !== 200)) expect([409, 412]).toContain(s);
    expect((await getBytes(key)).equals(bodies[winners[0]!]!)).toBe(true);
  });

  it('refuses a presigned PUT after its signature expires', async () => {
    const body = randomBytes(1024);
    const write = await presignPutObject(backupCfg, 'backup/expired.bin', body.length, NO_SSE, { expiresInSeconds: 1, ifNoneMatch: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await sendPresigned(write, body)).status).toBe(403);
    expect(await countUnder('backup/expired.bin')).toBe(0);
  });

  it('completes a presigned multipart upload and refuses a second create-only completion', async () => {
    const key = 'backup/multipart/object.bin';
    const parts = [randomBytes(5 * MiB), randomBytes(1024)];

    const { uploadId } = await createMultipartUpload(backupCfg, key, NO_SSE);
    const etags: Array<{ partNumber: number; etag: string }> = [];
    for (const [i, part] of parts.entries()) {
      const write = await presignUploadPart(backupCfg, key, uploadId, i + 1, part.length, 60);
      const res = await sendPresigned(write, part);
      expect(res.status).toBe(200);
      etags.push({ partNumber: i + 1, etag: res.headers.get('etag')! });
    }
    expect(await listMultipartUploads(backupCfg, 'backup/multipart/')).toEqual([{ key, uploadId }]);

    await completeMultipartUpload(backupCfg, key, uploadId, etags.reverse(), { ifNoneMatch: true });
    expect(sha256(await getBytes(key))).toBe(sha256(Buffer.concat(parts)));

    // A second upload to the same key must not replace it, and aborts cleanly.
    const again = await createMultipartUpload(backupCfg, key, NO_SSE);
    const part = randomBytes(1024);
    const res = await sendPresigned(await presignUploadPart(backupCfg, key, again.uploadId, 1, part.length, 60), part);
    await expect(completeMultipartUpload(backupCfg, key, again.uploadId,
      [{ partNumber: 1, etag: res.headers.get('etag')! }], { ifNoneMatch: true })).rejects.toBeInstanceOf(ObjectExistsError);
    await abortMultipartUpload(backupCfg, key, again.uploadId);
    await expect(abortMultipartUpload(backupCfg, key, again.uploadId)).resolves.toBeUndefined();
    expect(await listMultipartUploads(backupCfg, 'backup/multipart/')).toEqual([]);
    expect(sha256(await getBytes(key))).toBe(sha256(Buffer.concat(parts)));
  });

  it('pages a listing and batch-deletes more than one DeleteObjects batch, reporting every key', async () => {
    const prefix = 'backup/gc/';
    const keys = Array.from({ length: 1001 }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
    await mapLimit(keys, 32, (key) => admin.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'x' })));

    const listed: string[] = [];
    let token: string | null = null;
    do {
      const page = await listKeysUnderPrefix(backupCfg, prefix, { maxKeys: 400, continuationToken: token });
      listed.push(...page.keys);
      token = page.nextToken;
    } while (token);
    expect(listed.sort()).toEqual(keys);

    const result = await deleteKeys(backupCfg, keys);
    expect(result.failed).toEqual([]);
    expect(result.deleted.sort()).toEqual(keys);
    expect(await countUnder(prefix)).toBe(0);
  }, 120_000);
});
