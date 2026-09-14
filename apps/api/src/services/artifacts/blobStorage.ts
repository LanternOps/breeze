import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { coerceS3EndpointUrl } from '@breeze/shared';
import { breezeRegion } from '../../config/env';
import { classifyS3Failure, isS3NotFound } from '../s3Storage';

/**
 * Artifact blob store (execution-plane spec 2026-09-13 §5.2, §8, §9).
 *
 * Separate from `ticketAttachmentStorage.ts` on purpose: that module routes on
 * a PER-ROW `'s3' | 'db'` backend chosen at upload time and reads ONE platform
 * bucket through `s3Storage.ts`'s module-singleton client. Artifacts need a
 * PER-REGION bucket and client and have no `db` backend. Only the error
 * CLASSIFICATION helpers are shared; the ticket path is untouched by this wave.
 *
 * Invariants that must not drift:
 *
 *  - **Keys carry no tenant identifier** (§5.2, §8): `<region>/<yyyy>/<mm>/<uuid>`.
 *    An org merge or device move re-stamps rows only; objects never move. The
 *    row is the ONLY index to a key, so every delete path removes the blob
 *    BEFORE the row.
 *  - **`maxBytes` aborts the stream** rather than truncating: a truncated blob
 *    whose sha256 was computed over the truncated bytes would look intact
 *    forever. Over-cap is a typed error the caller turns into a tool error.
 *  - **A put failure is never a silent fallback** (§9). It throws
 *    `BlobStorageUnavailableError`; the capture path turns that into
 *    `{ error: 'artifact_store_unavailable' }` and does NOT return the raw
 *    result inline (which would bypass the context cap the capture exists for).
 *  - Per-region config falls back to the platform `S3_*` vars so a single-bucket
 *    dev stack (MinIO) works with no extra env.
 */

export type BlobRegion = 'eu' | 'us';

export interface BlobPutResult {
  key: string;
  bytes: number;
  sha256: string;
}

export interface BlobStorage {
  put(input: {
    region: BlobRegion;
    contentType: string;
    body: Buffer | NodeJS.ReadableStream;
    maxBytes: number;
  }): Promise<BlobPutResult>;
  openStream(key: string): Promise<NodeJS.ReadableStream>;
  /** Idempotent: deleting an absent key resolves. */
  delete(key: string): Promise<void>;
}

/** The provider is unreachable/misconfigured. Callers map this to §9's `artifact_store_unavailable` / HTTP 503. */
export class BlobStorageUnavailableError extends Error {
  readonly code = 'artifact_store_unavailable' as const;
  readonly status = 503 as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BlobStorageUnavailableError';
  }
}

/** The body exceeded the caller's cap. Nothing was stored. */
export class BlobTooLargeError extends Error {
  readonly code = 'artifact_too_large' as const;
  constructor(readonly limitBytes: number) {
    super(`Artifact body exceeds the ${limitBytes}-byte cap`);
    this.name = 'BlobTooLargeError';
  }
}

/** The key is genuinely absent (swept, or a failed compensating delete left the row). */
export class BlobNotFoundError extends Error {
  readonly code = 'artifact_blob_missing' as const;
  constructor(key: string) {
    super(`Artifact blob not found: ${key.slice(0, 64)}`);
    this.name = 'BlobNotFoundError';
  }
}

/** `<region>/<yyyy>/<mm>/<uuid>` — no org id, no run id, no filename (§5.2). */
export function blobKeyFor(region: BlobRegion, now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${region}/${yyyy}/${mm}/${randomUUID()}`;
}

/**
 * Read a body into memory, hashing as we go, and REFUSE at `maxBytes`.
 *
 * In-memory rather than a multipart `@aws-sdk/lib-storage` upload (decision 8):
 * the capture path already holds the whole string in memory, and every W01/W03
 * cap is far below `CAPTURE_MAX_BYTES`. If a later wave needs > 64 MiB single
 * blobs, add `lib-storage` and stream through it — the interface does not change.
 */
async function collectBounded(
  body: Buffer | NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ buffer: Buffer; sha256: string }> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw new BlobTooLargeError(maxBytes);
    return { buffer: body, sha256: createHash('sha256').update(body).digest('hex') };
  }
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of body) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    total += chunk.length;
    if (total > maxBytes) {
      // Stop pulling immediately; a partially-read source must not be stored.
      (body as Readable).destroy?.();
      throw new BlobTooLargeError(maxBytes);
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks, total), sha256: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// S3 backend
// ---------------------------------------------------------------------------

function envFor(region: BlobRegion, suffix: string): string | undefined {
  const scoped = process.env[`ARTIFACT_S3_${suffix}_${region.toUpperCase()}`];
  return scoped && scoped.trim() !== '' ? scoped.trim() : undefined;
}

function platformEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function bucketFor(region: BlobRegion): string {
  const bucket = envFor(region, 'BUCKET') ?? platformEnv('S3_BUCKET');
  if (!bucket) {
    throw new BlobStorageUnavailableError(
      `No artifact bucket configured for region ${region}: set ARTIFACT_S3_BUCKET_${region.toUpperCase()} or S3_BUCKET`,
    );
  }
  return bucket;
}

const clients = new Map<BlobRegion, S3Client>();

function clientFor(region: BlobRegion): S3Client {
  const cached = clients.get(region);
  if (cached) return cached;

  const accessKeyId = platformEnv('ARTIFACT_S3_ACCESS_KEY') ?? platformEnv('S3_ACCESS_KEY');
  const secretAccessKey = platformEnv('ARTIFACT_S3_SECRET_KEY') ?? platformEnv('S3_SECRET_KEY');
  if (!accessKeyId || !secretAccessKey) {
    throw new BlobStorageUnavailableError(
      'No artifact storage credentials: set ARTIFACT_S3_ACCESS_KEY/ARTIFACT_S3_SECRET_KEY (or S3_ACCESS_KEY/S3_SECRET_KEY)',
    );
  }

  let endpoint: string | undefined;
  try {
    endpoint = coerceS3EndpointUrl(envFor(region, 'ENDPOINT') ?? platformEnv('S3_ENDPOINT'));
  } catch (err) {
    // Never echo the value — an endpoint can carry inline credentials
    // (s3Storage.ts redactUrlCredentials, same reasoning).
    throw new BlobStorageUnavailableError(
      `ARTIFACT_S3_ENDPOINT_${region.toUpperCase()} (or S3_ENDPOINT) is not a valid URL`,
      { cause: err },
    );
  }

  const client = new S3Client({
    endpoint,
    region: envFor(region, 'REGION') ?? platformEnv('S3_REGION') ?? 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    // Required for MinIO and other path-style S3-compatible providers.
    forcePathStyle: true,
  });
  clients.set(region, client);
  return client;
}

/** Drop the cached clients so a test (or a config reload) rebuilds them. */
export function resetBlobClientsForTests(): void {
  clients.clear();
}

function unavailable(operation: string, err: unknown): BlobStorageUnavailableError {
  const classification = classifyS3Failure(err);
  console.error(`[artifacts/blobStorage] ${operation} failed: reason=${classification.code}`);
  return new BlobStorageUnavailableError(classification.message, { cause: err });
}

function createS3BlobStorage(): BlobStorage {
  return {
    async put({ region, contentType, body, maxBytes }) {
      // Bound + hash BEFORE touching the provider, so an over-cap body costs no
      // request and leaves no partial object.
      const { buffer, sha256 } = await collectBounded(body, maxBytes);
      const key = blobKeyFor(region);
      const sse = platformEnv('ARTIFACT_S3_SSE');
      try {
        await clientFor(region).send(
          new PutObjectCommand({
            Bucket: bucketFor(region),
            Key: key,
            Body: buffer,
            ContentLength: buffer.length,
            ContentType: contentType,
            Metadata: { sha256 },
            ...(sse ? { ServerSideEncryption: sse as 'AES256' } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof BlobStorageUnavailableError) throw err;
        throw unavailable('put', err);
      }
      return { key, bytes: buffer.length, sha256 };
    },

    async openStream(key) {
      const region = regionOfKey(key);
      try {
        const resp = await clientFor(region).send(
          new GetObjectCommand({ Bucket: bucketFor(region), Key: key }),
        );
        const stream = resp.Body as unknown as Readable | undefined;
        if (!stream) throw new BlobNotFoundError(key);
        return stream;
      } catch (err) {
        if (err instanceof BlobNotFoundError || err instanceof BlobStorageUnavailableError) throw err;
        // A genuinely absent key is NOT a transport fault — the route 404s it,
        // never a 503, and never the other way round (#1807/#1808 lesson).
        if (isS3NotFound(err)) throw new BlobNotFoundError(key);
        throw unavailable('openStream', err);
      }
    },

    async delete(key) {
      const region = regionOfKey(key);
      try {
        await clientFor(region).send(
          new DeleteObjectCommand({ Bucket: bucketFor(region), Key: key }),
        );
      } catch (err) {
        if (err instanceof BlobStorageUnavailableError) throw err;
        // S3 DeleteObject is already idempotent for a missing key; this arm
        // exists for providers that 404 instead.
        if (isS3NotFound(err)) return;
        throw unavailable('delete', err);
      }
    },
  };
}

/**
 * The region prefix of a key. An unknown or missing prefix falls back to the
 * DEPLOYMENT region (`breezeRegion()`, R1) rather than to a hard-coded 'us':
 * hard-coding would send an EU deployment's malformed-key lookups at the US
 * bucket, which is a residency violation dressed as a 404.
 */
function regionOfKey(key: string): BlobRegion {
  const prefix = key.split('/', 1)[0];
  if (prefix === 'eu' || prefix === 'us') return prefix;
  return breezeRegion();
}

// ---------------------------------------------------------------------------
// Memory backend (tests only — never selectable from env)
// ---------------------------------------------------------------------------

export function createMemoryBlobStorage(): BlobStorage & {
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    async put({ region, contentType, body, maxBytes }) {
      const { buffer, sha256 } = await collectBounded(body, maxBytes);
      const key = blobKeyFor(region);
      objects.set(key, { body: buffer, contentType });
      return { key, bytes: buffer.length, sha256 };
    },
    async openStream(key) {
      const found = objects.get(key);
      if (!found) throw new BlobNotFoundError(key);
      return Readable.from([found.body]);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

let override: BlobStorage | null = null;
let s3Singleton: BlobStorage | null = null;

/** Inject a double for the duration of a test; pass `null` in `afterEach`. */
export function setBlobStorageForTests(storage: BlobStorage | null): void {
  override = storage;
}

export function getBlobStorage(): BlobStorage {
  if (override) return override;
  const backend = (process.env.ARTIFACT_BLOB_BACKEND ?? 's3').trim().toLowerCase() || 's3';
  if (backend === 'db') {
    // config/validate.ts already refuses this at boot; this is the second line
    // of defence for a process that skipped validation (a script, a test env).
    throw new Error(
      'ARTIFACT_BLOB_BACKEND=db is not available in v1 — there is no generic blob table. Use "s3" (MinIO works locally through S3_ENDPOINT).',
    );
  }
  if (backend !== 's3') {
    throw new Error(`ARTIFACT_BLOB_BACKEND must be "s3" when set (got "${backend}")`);
  }
  s3Singleton ??= createS3BlobStorage();
  return s3Singleton;
}
