/**
 * Server-side S3 operations for brokered backup writes
 * (services/backupStorageWriteSessions.ts).
 *
 * Only two operations are ever handed to a device, as presigned URLs: a
 * single-object PUT and a multipart UploadPart. Each URL is bound to one key,
 * signs its exact size, and — for a PUT when the destination supports it —
 * a create-only condition (`If-None-Match: *`), so it can create that object
 * but never replace one. Server-side encryption is signed as headers. The
 * returned `headers` are exactly what the device must send.
 *
 * Everything else (create/complete/abort a multipart upload, list, delete)
 * runs here with the destination's own credential, after the write session
 * has authorized the exact key.
 */
import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildS3StorageClient } from './backupSnapshotStorage';

export type StorageProviderConfig = Record<string, unknown>;

/** Server-side encryption a brokered write must carry (the enqueue-time plan). */
export type WriteSse =
  | { mode: 'disabled' }
  | { mode: 's3-sse-s3' }
  | { mode: 's3-sse-kms'; keyId: string };

/** S3 limits (single PUT, multipart part size and count). */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3;
export const MIN_PART_BYTES = 5 * 1024 ** 2;
export const MAX_PARTS = 10_000;
/** Hard ceiling for every presigned write URL. */
export const MAX_WRITE_URL_TTL_SECONDS = 300;
export const CAPABILITY_PROBE_PREFIX = 'breeze-capability-probe/';
/** Upper bound for one server-side storage request (a completion may take longer). */
export const STORAGE_CALL_TIMEOUT_MS = 30_000;
export const MULTIPART_COMPLETE_TIMEOUT_MS = 15 * 60 * 1000;

function bounded(ms: number = STORAGE_CALL_TIMEOUT_MS): { abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(ms) };
}

/** A create-only write found the object already present (HTTP 412). */
export class ObjectExistsError extends Error {
  constructor(key: string) {
    super(`object already exists: ${key}`);
    this.name = 'ObjectExistsError';
  }
}

export type PresignedWrite = { url: string; headers: Record<string, string>; expiresAt: Date };

function httpStatusOf(err: unknown): number | null {
  const meta = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata;
  return typeof meta?.httpStatusCode === 'number' ? meta.httpStatusCode : null;
}

function errorName(err: unknown): string {
  return (err as { name?: unknown; Code?: unknown } | null)?.name as string
    ?? String((err as { Code?: unknown } | null)?.Code ?? '');
}

function isPreconditionFailed(err: unknown): boolean {
  return httpStatusOf(err) === 412 || errorName(err) === 'PreconditionFailed';
}

function ttlSeconds(requested: number): number {
  if (!Number.isFinite(requested)) return MAX_WRITE_URL_TTL_SECONDS;
  return Math.max(1, Math.min(MAX_WRITE_URL_TTL_SECONDS, Math.floor(requested)));
}

function assertSize(size: number, max: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > max) {
    throw new Error(`object size ${size} is outside the allowed range`);
  }
}

function sseInput(sse: WriteSse): { ServerSideEncryption?: 'AES256' | 'aws:kms'; SSEKMSKeyId?: string } {
  if (sse.mode === 's3-sse-s3') return { ServerSideEncryption: 'AES256' };
  if (sse.mode === 's3-sse-kms') {
    if (!sse.keyId) throw new Error('KMS encryption requires a key id');
    return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: sse.keyId };
  }
  return {};
}

function sseHeaders(sse: WriteSse): Record<string, string> {
  if (sse.mode === 's3-sse-s3') return { 'x-amz-server-side-encryption': 'AES256' };
  if (sse.mode === 's3-sse-kms') {
    return {
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': sse.keyId,
    };
  }
  return {};
}

function client(cfg: StorageProviderConfig) {
  return buildS3StorageClient(cfg);
}

/**
 * The client used for presigning device uploads. The SDK otherwise computes a
 * body checksum while signing — of the EMPTY body a presign request carries —
 * and signs it into the URL, so the store would refuse every real upload.
 * The device sends the body; only the size is signed.
 */
function presignClient(cfg: StorageProviderConfig) {
  return buildS3StorageClient(cfg, { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
}

async function presign(
  cfg: StorageProviderConfig,
  command: PutObjectCommand | UploadPartCommand,
  headers: Record<string, string>,
  expiresInSeconds: number,
): Promise<PresignedWrite> {
  const { client: s3 } = presignClient(cfg);
  const expiresIn = ttlSeconds(expiresInSeconds);
  const names = new Set(Object.keys(headers));
  const url = await (getSignedUrl as (...args: unknown[]) => Promise<string>)(s3, command, {
    expiresIn,
    // Every header the device must send is signed, and stays a header (an
    // x-amz-* header would otherwise be hoisted into the query string).
    signableHeaders: names,
    unhoistableHeaders: names,
  });
  return { url, headers: { ...headers }, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

export async function presignPutObject(
  cfg: StorageProviderConfig,
  key: string,
  size: number,
  sse: WriteSse,
  opts: { expiresInSeconds: number; ifNoneMatch: boolean },
): Promise<PresignedWrite> {
  assertSize(size, MAX_SINGLE_PUT_BYTES);
  const { bucket } = client(cfg);
  const headers: Record<string, string> = { 'content-length': String(size), ...sseHeaders(sse) };
  if (opts.ifNoneMatch) headers['if-none-match'] = '*';
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentLength: size,
    ...sseInput(sse),
    ...(opts.ifNoneMatch ? { IfNoneMatch: '*' } : {}),
  });
  return presign(cfg, command, headers, opts.expiresInSeconds);
}

export async function presignUploadPart(
  cfg: StorageProviderConfig,
  key: string,
  uploadId: string,
  partNumber: number,
  size: number,
  expiresInSeconds: number,
): Promise<PresignedWrite> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
    throw new Error(`part number ${partNumber} is outside the allowed range`);
  }
  assertSize(size, MAX_SINGLE_PUT_BYTES);
  const { bucket } = client(cfg);
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
    ContentLength: size,
  });
  return presign(cfg, command, { 'content-length': String(size) }, expiresInSeconds);
}

export async function createMultipartUpload(cfg: StorageProviderConfig, key: string, sse: WriteSse): Promise<string> {
  const { bucket, client: s3 } = client(cfg);
  const out = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ...sseInput(sse) }), bounded());
  if (!out.UploadId) throw new Error('storage did not return a multipart upload id');
  return out.UploadId;
}

export async function completeMultipartUpload(
  cfg: StorageProviderConfig,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  opts: { ifNoneMatch: boolean },
): Promise<void> {
  const { bucket, client: s3 } = client(cfg);
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  try {
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: ordered.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      ...(opts.ifNoneMatch ? { IfNoneMatch: '*' } : {}),
    }), bounded(MULTIPART_COMPLETE_TIMEOUT_MS));
  } catch (err) {
    if (isPreconditionFailed(err)) throw new ObjectExistsError(key);
    throw err;
  }
}

/** Aborts one multipart upload. An upload that no longer exists counts as aborted. */
export async function abortMultipartUpload(cfg: StorageProviderConfig, key: string, uploadId: string): Promise<void> {
  const { bucket, client: s3 } = client(cfg);
  try {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), bounded());
  } catch (err) {
    if (errorName(err) === 'NoSuchUpload' || httpStatusOf(err) === 404) return;
    throw err;
  }
}

export async function listMultipartUploads(
  cfg: StorageProviderConfig,
  prefix: string,
): Promise<Array<{ key: string; uploadId: string }>> {
  if (!prefix.endsWith('/')) throw new Error('multipart listing prefix must end with "/"');
  const { bucket, client: s3 } = client(cfg);
  const out: Array<{ key: string; uploadId: string }> = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const res = await s3.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: prefix,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
    }), bounded());
    for (const u of res.Uploads ?? []) {
      if (u.Key && u.UploadId && u.Key.startsWith(prefix)) out.push({ key: u.Key, uploadId: u.UploadId });
    }
    if (!res.IsTruncated) break;
    keyMarker = res.NextKeyMarker;
    uploadIdMarker = res.NextUploadIdMarker;
    if (!keyMarker && !uploadIdMarker) break;
  }
  return out;
}

export async function listKeysUnderPrefix(
  cfg: StorageProviderConfig,
  prefix: string,
  opts: { maxKeys: number; continuationToken?: string | null },
): Promise<{ keys: string[]; nextToken: string | null }> {
  if (!prefix.endsWith('/')) throw new Error('listing prefix must end with "/"');
  const { bucket, client: s3 } = client(cfg);
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: Math.max(1, Math.min(1000, Math.floor(opts.maxKeys))),
    ...(opts.continuationToken ? { ContinuationToken: opts.continuationToken } : {}),
  }), bounded());
  const keys = (res.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
  return { keys, nextToken: res.IsTruncated && res.NextContinuationToken ? res.NextContinuationToken : null };
}

export async function deleteKeys(
  cfg: StorageProviderConfig,
  keys: string[],
): Promise<{ deleted: string[]; failed: Array<{ key: string; code: string }> }> {
  const { bucket, client: s3 } = client(cfg);
  const deleted: string[] = [];
  const failed: Array<{ key: string; code: string }> = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
    }), bounded());
    for (const d of res.Deleted ?? []) if (d.Key) deleted.push(d.Key);
    for (const e of res.Errors ?? []) if (e.Key) failed.push({ key: e.Key, code: e.Code ?? 'unknown' });
  }
  return { deleted, failed };
}

/**
 * Whether the destination honours a create-only condition: writes one probe
 * object, then writes it again with `If-None-Match: *`. Only a 412 on the
 * second write proves support; a second write that succeeds (the condition
 * was ignored) or any error means "not supported". The probe object is
 * removed either way (best effort).
 */
export async function probeConditionalWrites(cfg: StorageProviderConfig): Promise<boolean> {
  const { bucket, client: s3 } = client(cfg);
  const key = `${CAPABILITY_PROBE_PREFIX}${randomUUID()}`;
  let supported = false;
  let wrote = false;
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'probe', IfNoneMatch: '*' }));
    wrote = true;
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'probe', IfNoneMatch: '*' }));
      supported = false;
    } catch (err) {
      supported = isPreconditionFailed(err);
    }
  } catch {
    supported = false;
  }
  if (wrote) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
  }
  return supported;
}
