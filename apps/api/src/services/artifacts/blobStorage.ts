import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
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
 *    forever. Over-cap is a typed error the caller turns into a tool error, and
 *    the multipart upload is ABORTED so no partial object survives the refusal.
 *  - **The put STREAMS** through `@aws-sdk/lib-storage`'s multipart `Upload`
 *    (W06, #5774 option 2 — supersedes W01 decision 8, which buffered the whole
 *    body). Peak resident memory is on the order of
 *    `(ARTIFACT_UPLOAD_QUEUE_SIZE + 1) * ARTIFACT_UPLOAD_PART_SIZE` (~24 MiB
 *    today — `queueSize` parts in flight plus the one the shared chunker is
 *    accumulating for the next free worker), and is NEVER a function of
 *    `maxBytes`: W03's `EXPORT_DEFAULT_MAX_BYTES` is 256 MiB and `Buffer.concat`
 *    over that roughly doubled peak RSS, so a full-budget export could OOM an
 *    API pod. There is ONE upload path — a sub-part body still goes through
 *    `Upload`, which issues a single `PutObject` internally.
 *  - **The object carries no `sha256` metadata.** A multipart upload has to name
 *    its metadata at `CreateMultipartUpload`, before the digest of the streamed
 *    bytes exists. Nothing reads the object metadata (verified 2026-09-14: the
 *    only consumer of an artifact digest is `ai_run_artifacts.sha256`, written
 *    by `artifactService.createArtifact` from this function's return value), so
 *    the row stays the single source of truth rather than paying a self-copy
 *    round-trip to restore a field with no reader.
 *  - **A put failure is never a silent fallback** (§9). It throws
 *    `BlobStorageUnavailableError`; the capture path turns that into
 *    `{ error: 'artifact_store_unavailable' }` and does NOT return the raw
 *    result inline (which would bypass the context cap the capture exists for).
 *    ACCEPTED LIMITATION: when a provider fault AND the cleanup abort both fail,
 *    `lib-storage`'s `markUploadAsAborted()` throws the ABORT's error and drops
 *    the original one, so the log line names the abort's classification rather
 *    than the precipitating fault. Only the cap error is protected from this
 *    (it is captured on the pass-through and re-thrown), because only it is ours
 *    to hold. The upload still fails loudly; only the attributed cause is lossy.
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
  /**
   * Inclusive byte range, for paged tool reads (A-W05 D13a). A whole-object
   * `openStream` per 6 000-char page would be O(n²) egress on a 64 MiB
   * artifact; this reads exactly the window a caller asked for.
   */
  openRange(key: string, start: number, endInclusive: number): Promise<NodeJS.ReadableStream>;
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
 * Multipart part size, and the RSS cost of one in-flight part. Chosen above
 * lib-storage's own 5 MiB minimum (`Upload.MIN_PART_SIZE`, below which it throws
 * `EntityTooSmall`) to keep the part count low on a 256 MiB export.
 */
export const ARTIFACT_UPLOAD_PART_SIZE = 8 * 1024 * 1024;
/** Parts uploaded concurrently. Peak ≈ (QUEUE_SIZE + 1) * PART_SIZE, independent of `maxBytes`. */
export const ARTIFACT_UPLOAD_QUEUE_SIZE = 2;

/**
 * A pass-through that counts and hashes bytes as they flow and FAILS the stream
 * at `maxBytes` — the streaming half of the abort-never-truncate invariant.
 *
 * The cap error is kept on the handle as well as emitted, because the consumer
 * (`Upload`) may surface a *different* error once it tears down (an abort that
 * itself failed, for instance). `put` re-throws the captured `BlobTooLargeError`
 * so the refusal is never masked by its own cleanup.
 */
function boundedHashingPassThrough(maxBytes: number) {
  const hash = createHash('sha256');
  let bytes = 0;
  let capError: BlobTooLargeError | null = null;

  const stream = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + buffer.length > maxBytes) {
        capError = new BlobTooLargeError(maxBytes);
        callback(capError);
        return;
      }
      bytes += buffer.length;
      hash.update(buffer);
      callback(null, buffer);
    },
  });

  return {
    stream,
    get bytes() {
      return bytes;
    },
    get capError(): BlobTooLargeError | null {
      return capError;
    },
    digest: () => hash.digest('hex'),
  };
}

/**
 * Read a body into memory, hashing as we go, and REFUSE at `maxBytes`.
 *
 * Retained ONLY for `createMemoryBlobStorage`, the in-process test double, which
 * has no provider to stream to. The S3 path streams (see the header comment);
 * W01's decision 8 — "in-memory rather than a multipart `lib-storage` upload" —
 * is superseded by W06 (#5774) and must not be reinstated for a real provider.
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

export function createS3BlobStorage(
  /** `clientFor` is injectable so a test can drive the REAL `Upload` against a stub client. */
  deps: { clientFor?: (region: BlobRegion) => S3Client } = {},
): BlobStorage {
  const resolveClient = deps.clientFor ?? clientFor;
  return {
    async put({ region, contentType, body, maxBytes }) {
      // A Buffer's size is known up front, so refuse it before spending a request.
      if (Buffer.isBuffer(body) && body.length > maxBytes) throw new BlobTooLargeError(maxBytes);

      const source: Readable = Buffer.isBuffer(body)
        ? Readable.from([body])
        : (body as unknown as Readable);
      const counter = boundedHashingPassThrough(maxBytes);
      const key = blobKeyFor(region);
      const sse = platformEnv('ARTIFACT_S3_SSE');
      // Resolve config BEFORE opening the upload: a misconfiguration is a
      // BlobStorageUnavailableError, not a dangling multipart upload. Destroy
      // the caller's body on that path too — nothing downstream will ever read
      // it, and a live export reader would otherwise sit there un-drained.
      let bucket: string;
      let client: S3Client;
      try {
        bucket = bucketFor(region);
        client = resolveClient(region);
      } catch (err) {
        source.destroy();
        throw err;
      }

      // `pipeline` (not `.pipe`) so a cap refusal destroys the SOURCE too — a
      // half-read export must not be left dribbling into a dead transform.
      pipeline(source, counter.stream, () => {
        // Errors reach `Upload` through the destroyed stream; `counter.capError`
        // carries the refusal. Nothing to do here, but the callback is required.
      });

      try {
        await new Upload({
          client,
          partSize: ARTIFACT_UPLOAD_PART_SIZE,
          queueSize: ARTIFACT_UPLOAD_QUEUE_SIZE,
          // Abort on failure so an over-cap or faulted body leaves no parts.
          leavePartsOnError: false,
          params: {
            Bucket: bucket,
            Key: key,
            Body: counter.stream,
            ContentType: contentType,
            ...(sse ? { ServerSideEncryption: sse as 'AES256' } : {}),
          },
        }).done();
      } catch (err) {
        // The cap wins over whatever the teardown reported (e.g. a failed abort).
        if (counter.capError) throw counter.capError;
        if (err instanceof BlobTooLargeError) throw err;
        if (err instanceof BlobStorageUnavailableError) throw err;
        throw unavailable('put', err);
      }
      return { key, bytes: counter.bytes, sha256: counter.digest() };
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

    async openRange(key, start, endInclusive) {
      const region = regionOfKey(key);
      try {
        const resp = await resolveClient(region).send(
          new GetObjectCommand({ Bucket: bucketFor(region), Key: key, Range: `bytes=${start}-${endInclusive}` }),
        );
        const stream = resp.Body as unknown as Readable | undefined;
        if (!stream) throw new BlobNotFoundError(key);
        return stream;
      } catch (err) {
        if (err instanceof BlobNotFoundError || err instanceof BlobStorageUnavailableError) throw err;
        // Same posture as openStream: a genuinely absent key is NOT a
        // transport fault (#1807/#1808 lesson).
        if (isS3NotFound(err)) throw new BlobNotFoundError(key);
        throw unavailable('openRange', err);
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
    async openRange(key, start, endInclusive) {
      const found = objects.get(key);
      if (!found) throw new BlobNotFoundError(key);
      return Readable.from([found.body.subarray(Math.max(0, start), endInclusive + 1)]);
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
