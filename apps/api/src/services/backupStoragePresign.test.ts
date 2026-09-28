import { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ client: null as unknown as S3Client, send: vi.fn(), overrides: [] as unknown[] }));

// Builds a real client with whatever client options the module asks for, so
// the presigned URLs below are exactly what the SDK would produce.
vi.mock('./backupSnapshotStorage', () => ({
  buildS3StorageClient: (_cfg: unknown, overrides: Record<string, unknown> = {}) => {
    holder.overrides.push(overrides);
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'https://storage.example',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG' },
      ...overrides,
    });
    (client as unknown as { send: unknown }).send = holder.send;
    return { bucket: 'tenant-bucket', client };
  },
}));

import {
  MAX_PARTS,
  MAX_SINGLE_PUT_BYTES,
  MIN_PART_BYTES,
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
} from './backupStoragePresign';

const CFG = { bucket: 'tenant-bucket', region: 'us-east-1', endpoint: 'https://storage.example' };
const KEY = 'snapshots/snapshot-20261108T120000Z-0123456789abcdef01234567/files/a.bin';

function signedHeaders(url: string): string[] {
  return (new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
}

function httpError(status: number, name: string): Error {
  const err = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } };
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

beforeEach(() => {
  holder.send.mockReset();
  holder.overrides = [];
});

function checksumParams(url: string): string[] {
  return [...new URL(url).searchParams.keys()].filter((k) => /checksum/i.test(k));
}

describe('presignPutObject', () => {
  it('signs the size and the create-only condition when requested, and returns exactly the headers to send', async () => {
    const out = await presignPutObject(CFG, KEY, 1234, { mode: 'disabled' }, { expiresInSeconds: 120, ifNoneMatch: true });
    expect(signedHeaders(out.url)).toEqual(expect.arrayContaining(['content-length', 'host', 'if-none-match']));
    expect(out.headers).toEqual({ 'content-length': '1234', 'if-none-match': '*' });
    expect(out.url).not.toContain('wJalrXUtnFEMI');
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  it('omits the condition when not requested', async () => {
    const out = await presignPutObject(CFG, KEY, 10, { mode: 'disabled' }, { expiresInSeconds: 60, ifNoneMatch: false });
    expect(signedHeaders(out.url)).not.toContain('if-none-match');
    expect(out.headers).toEqual({ 'content-length': '10' });
  });

  it('signs server-side encryption as headers, never as query parameters', async () => {
    const kms = await presignPutObject(CFG, KEY, 10, { mode: 's3-sse-kms', keyId: 'key-1' }, { expiresInSeconds: 60, ifNoneMatch: false });
    expect(kms.headers).toMatchObject({
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': 'key-1',
    });
    expect(signedHeaders(kms.url)).toEqual(expect.arrayContaining([
      'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id',
    ]));
    expect(new URL(kms.url).searchParams.has('x-amz-server-side-encryption')).toBe(false);
    const s3 = await presignPutObject(CFG, KEY, 10, { mode: 's3-sse-s3' }, { expiresInSeconds: 60, ifNoneMatch: false });
    expect(s3.headers['x-amz-server-side-encryption']).toBe('AES256');
  });

  it('caps the URL lifetime at 300 seconds and refuses out-of-range sizes', async () => {
    const out = await presignPutObject(CFG, KEY, 1, { mode: 'disabled' }, { expiresInSeconds: 9999, ifNoneMatch: false });
    expect(new URL(out.url).searchParams.get('X-Amz-Expires')).toBe('300');
    await expect(presignPutObject(CFG, KEY, MAX_SINGLE_PUT_BYTES + 1, { mode: 'disabled' }, { expiresInSeconds: 60, ifNoneMatch: false }))
      .rejects.toThrow(/size/);
    await expect(presignPutObject(CFG, KEY, -1, { mode: 'disabled' }, { expiresInSeconds: 60, ifNoneMatch: false }))
      .rejects.toThrow(/size/);
  });
});

describe('presigned write URLs carry no precomputed body checksum', () => {
  it('PUT and UploadPart URLs sign no checksum of an empty body', async () => {
    const put = await presignPutObject(CFG, KEY, 1234, { mode: 'disabled' }, { expiresInSeconds: 60, ifNoneMatch: true });
    const part = await presignUploadPart(CFG, KEY, 'upload-1', 1, MIN_PART_BYTES, 60);
    expect(checksumParams(put.url)).toEqual([]);
    expect(checksumParams(part.url)).toEqual([]);
    expect(Object.keys(put.headers).filter((h) => /checksum/i.test(h))).toEqual([]);
  });
});

describe('presignUploadPart', () => {
  it('signs the part size and binds the upload id and part number', async () => {
    const out = await presignUploadPart(CFG, KEY, 'upload-1', 3, MIN_PART_BYTES, 60);
    const url = new URL(out.url);
    expect(url.searchParams.get('uploadId')).toBe('upload-1');
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(signedHeaders(out.url)).toContain('content-length');
    expect(out.headers).toEqual({ 'content-length': String(MIN_PART_BYTES) });
  });

  it('refuses part numbers and sizes outside the store limits', async () => {
    await expect(presignUploadPart(CFG, KEY, 'u', 0, 10, 60)).rejects.toThrow(/part number/);
    await expect(presignUploadPart(CFG, KEY, 'u', MAX_PARTS + 1, 10, 60)).rejects.toThrow(/part number/);
    await expect(presignUploadPart(CFG, KEY, 'u', 1, MAX_SINGLE_PUT_BYTES + 1, 60)).rejects.toThrow(/size/);
  });
});

describe('server-side multipart operations', () => {
  it('creates an upload with the planned encryption', async () => {
    holder.send.mockResolvedValueOnce({ UploadId: 'u-1' });
    await expect(createMultipartUpload(CFG, KEY, { mode: 's3-sse-kms', keyId: 'k' })).resolves.toBe('u-1');
    const input = holder.send.mock.calls[0]![0].input;
    expect(input).toMatchObject({ Bucket: 'tenant-bucket', Key: KEY, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'k' });
  });

  it('completes with the create-only condition and maps a 412 to ObjectExistsError', async () => {
    holder.send.mockResolvedValueOnce({});
    await completeMultipartUpload(CFG, KEY, 'u-1', [{ partNumber: 2, etag: '"b"' }, { partNumber: 1, etag: '"a"' }], { ifNoneMatch: true });
    expect(holder.send.mock.calls[0]![0].input).toMatchObject({
      UploadId: 'u-1',
      IfNoneMatch: '*',
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"a"' }, { PartNumber: 2, ETag: '"b"' }] },
    });
    holder.send.mockRejectedValueOnce(httpError(412, 'PreconditionFailed'));
    await expect(completeMultipartUpload(CFG, KEY, 'u-1', [{ partNumber: 1, etag: '"a"' }], { ifNoneMatch: true }))
      .rejects.toBeInstanceOf(ObjectExistsError);
  });

  it('treats an upload that no longer exists as aborted', async () => {
    holder.send.mockRejectedValueOnce(httpError(404, 'NoSuchUpload'));
    await expect(abortMultipartUpload(CFG, KEY, 'gone')).resolves.toBeUndefined();
    holder.send.mockRejectedValueOnce(httpError(500, 'InternalError'));
    await expect(abortMultipartUpload(CFG, KEY, 'x')).rejects.toThrow();
  });

  it('lists every multipart upload under a prefix across pages', async () => {
    holder.send
      .mockResolvedValueOnce({ Uploads: [{ Key: 'snapshots/s/a', UploadId: '1' }], IsTruncated: true, NextKeyMarker: 'k', NextUploadIdMarker: 'u' })
      .mockResolvedValueOnce({ Uploads: [{ Key: 'snapshots/s/b', UploadId: '2' }], IsTruncated: false });
    await expect(listMultipartUploads(CFG, 'snapshots/s/')).resolves.toEqual([
      { key: 'snapshots/s/a', uploadId: '1' },
      { key: 'snapshots/s/b', uploadId: '2' },
    ]);
    expect(holder.send.mock.calls[1]![0].input).toMatchObject({ KeyMarker: 'k', UploadIdMarker: 'u', Prefix: 'snapshots/s/' });
  });
});

describe('listKeysUnderPrefix / deleteKeys', () => {
  it('refuses a prefix that is not slash-terminated', async () => {
    await expect(listKeysUnderPrefix(CFG, 'snapshots/s', { maxKeys: 10 })).rejects.toThrow(/prefix/);
    expect(holder.send).not.toHaveBeenCalled();
  });

  it('lists without a delimiter and returns the continuation token', async () => {
    holder.send.mockResolvedValueOnce({ Contents: [{ Key: 'snapshots/s/a' }], IsTruncated: true, NextContinuationToken: 'next' });
    await expect(listKeysUnderPrefix(CFG, 'snapshots/s/', { maxKeys: 5, continuationToken: 'prev' }))
      .resolves.toEqual({ keys: ['snapshots/s/a'], nextToken: 'next' });
    const input = holder.send.mock.calls[0]![0].input;
    expect(input).toMatchObject({ Prefix: 'snapshots/s/', MaxKeys: 5, ContinuationToken: 'prev' });
    expect(input.Delimiter).toBeUndefined();
  });

  it('reports per-key delete failures', async () => {
    holder.send.mockResolvedValueOnce({ Deleted: [{ Key: 'a' }], Errors: [{ Key: 'b', Code: 'AccessDenied' }] });
    await expect(deleteKeys(CFG, ['a', 'b'])).resolves.toEqual({ deleted: ['a'], failed: [{ key: 'b', code: 'AccessDenied' }] });
  });
});

describe('probeConditionalWrites', () => {
  it('is supported only when the second create-only write is refused with 412; removes the probe by version', async () => {
    holder.send
      .mockResolvedValueOnce({ VersionId: 'v1' })
      .mockRejectedValueOnce(httpError(412, 'PreconditionFailed'))
      .mockResolvedValueOnce({});
    await expect(probeConditionalWrites(CFG)).resolves.toEqual({ supported: true, reason: 'precondition_enforced' });
    const [first, second, cleanup] = holder.send.mock.calls.map((c) => c[0].input);
    expect(first.Key).toMatch(/^breeze-capability-probe\/[0-9a-f-]{36}$/);
    expect(second).toMatchObject({ Key: first.Key, IfNoneMatch: '*' });
    expect(cleanup).toMatchObject({ Key: first.Key, VersionId: 'v1' });
    // Every storage call is time-bounded.
    for (const call of holder.send.mock.calls) expect(call[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('is unsupported when the condition is ignored, and removes both versions', async () => {
    holder.send
      .mockResolvedValueOnce({ VersionId: 'v1' })
      .mockResolvedValueOnce({ VersionId: 'v2' })
      .mockResolvedValue({});
    await expect(probeConditionalWrites(CFG)).resolves.toEqual({ supported: false, reason: 'condition_ignored' });
    const deletes = holder.send.mock.calls.slice(2).map((c) => c[0].input.VersionId);
    expect(deletes.sort()).toEqual(['v1', 'v2']);
  });

  it('is unsupported on any other error, with a reason', async () => {
    holder.send.mockRejectedValueOnce(httpError(403, 'AccessDenied'));
    await expect(probeConditionalWrites(CFG)).resolves.toEqual({ supported: false, reason: 'probe_write_failed' });
    holder.send.mockResolvedValueOnce({}).mockRejectedValueOnce(httpError(500, 'InternalError')).mockResolvedValue({});
    await expect(probeConditionalWrites(CFG)).resolves.toEqual({ supported: false, reason: 'unexpected_response' });
  });
});
