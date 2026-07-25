import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { coerceS3EndpointUrl } from '@breeze/shared';
import { createReadStream, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

let s3Client: S3Client | null = null;

/**
 * Object storage is misconfigured (missing/unparseable env var). The operator
 * has to change `.env` — retrying will never help. Callers map this to a 503,
 * matching the existing `isS3Configured()` gate.
 *
 * `message` may quote the offending env var VALUE (credential-redacted) so the
 * fault is diagnosable in Sentry and the API log. Callers returning anything to
 * an HTTP client must use `clientMessage`, which names the env var and never
 * its value — see the S3_ENDPOINT case in `getS3Client`.
 */
export class S3ConfigError extends Error {
  /** Curated text safe for an API response body: names the env var, never its value. */
  readonly clientMessage: string;

  constructor(message: string, clientMessage?: string) {
    super(message);
    this.name = 'S3ConfigError';
    this.clientMessage = clientMessage ?? message;
  }
}

/**
 * An object storage request reached the provider (or tried to) and failed.
 * `message` is a curated, operator-actionable hint — safe to return in an API
 * response body. Callers map this to a 502.
 */
export class S3OperationError extends Error {
  readonly failureCode: S3FailureCode;
  readonly operation: string;

  constructor(operation: string, classification: S3FailureClassification, cause: unknown) {
    super(classification.message, { cause });
    this.name = 'S3OperationError';
    this.failureCode = classification.code;
    this.operation = operation;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new S3ConfigError(`Missing required env var: ${name}`);
  return value;
}

function requireBucket(): string {
  return requireEnv('S3_BUCKET');
}

/**
 * Strip `user:password@` userinfo out of any URL-ish substring so a
 * credential-bearing endpoint can't ride along inside an error message. Keeps
 * the rest of the value, which is the part that makes the fault diagnosable
 * (wrong scheme, stray quote, trailing slash).
 *
 * Matches on `<scheme>://<userinfo>@` rather than parsing, because the values
 * that reach here are by definition the ones `new URL()` refused.
 */
function redactUrlCredentials(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]*@/g, '$1***@');
}

function getS3Client(): S3Client {
  if (!s3Client) {
    const accessKeyId = requireEnv('S3_ACCESS_KEY');
    const secretAccessKey = requireEnv('S3_SECRET_KEY');

    // A scheme-less S3_ENDPOINT would otherwise reach the SDK and fail
    // opaquely inside @smithy/core's endpoint resolver the first time it's
    // used, instead of naming the misconfigured env var (Sentry BREEZE-P).
    // Two distinct failure modes depending on the shape — a bare host throws
    // `TypeError: Invalid URL`, a `host:port` parses to an empty host and
    // fails later as a connection error. See coerceS3EndpointUrl.
    let endpoint: string | undefined;
    try {
      endpoint = coerceS3EndpointUrl(process.env.S3_ENDPOINT);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // `coerceS3EndpointUrl` quotes the raw endpoint back in its message, and
      // an endpoint can carry inline credentials (`s3://key:secret@host`).
      // Two layers here: `redactUrlCredentials` strips the userinfo so no
      // secret sits in the Error at all (it would otherwise reach Sentry and
      // any `err.message` logger), and the client-facing variant drops the
      // value entirely so an API caller only learns which env var is wrong.
      throw new S3ConfigError(
        `Invalid S3_ENDPOINT env var: ${redactUrlCredentials(detail)}`,
        'The S3_ENDPOINT env var is not a valid URL. Expected a host (s3.example.com) or host:port (minio.local:9000), optionally prefixed with http:// or https://.'
      );
    }

    s3Client = new S3Client({
      endpoint,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      // Required for MinIO and other S3-compatible providers that use path-style URLs
      forcePathStyle: true,
    });
  }
  return s3Client;
}

export function isS3Configured(): boolean {
  return !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
}

// Distinguishes a genuine "object not present" from a transport/auth fault.
// Only NotFound/NoSuchKey mean the key is absent; anything else (timeouts,
// AccessDenied, DNS, 5xx) is a real fault that callers must surface instead of
// masking as a 404 / silent disk fallback (#1807, #1808).
export function isS3NotFound(err: unknown): boolean {
  const errName = (err as { name?: string }).name;
  return errName === 'NotFound' || errName === 'NoSuchKey';
}

// ---------------------------------------------------------------------------
// Object storage failure classification (#2794)
//
// Every S3 fault used to escape as a bare `500 Internal Server Error`, so a
// self-hoster had no path from "Failed to upload version" to a cause. These
// map the codes the AWS SDK / Node net+TLS layers actually produce onto hints
// that name the env var to go fix.
// ---------------------------------------------------------------------------

export type S3FailureCode =
  | 'credentials_invalid'
  | 'credentials_signature'
  | 'bucket_missing'
  | 'access_denied'
  | 'region_mismatch'
  | 'clock_skew'
  | 'endpoint_refused'
  | 'endpoint_dns'
  | 'endpoint_unreachable'
  | 'endpoint_tls'
  | 'provider_error'
  | 'unknown';

export interface S3FailureClassification {
  /** Stable short code for logs, tests, and support triage. */
  code: S3FailureCode;
  /** Operator-actionable hint. Curated text only — never raw provider output. */
  message: string;
}

const S3_FAILURE_RULES: ReadonlyArray<{
  codes: readonly string[];
  code: S3FailureCode;
  message: string;
}> = [
  {
    codes: ['InvalidAccessKeyId', 'InvalidAccessKeyID', 'InvalidSecurity', 'InvalidClientTokenId'],
    code: 'credentials_invalid',
    message:
      'Object storage rejected the access key. Check that S3_ACCESS_KEY names a key that exists on the storage provider.',
  },
  {
    codes: ['SignatureDoesNotMatch'],
    code: 'credentials_signature',
    message:
      'Object storage rejected the request signature. Check S3_SECRET_KEY for a typo, a truncated value, or trailing whitespace.',
  },
  {
    codes: ['NoSuchBucket'],
    code: 'bucket_missing',
    message:
      'The configured bucket does not exist on the storage provider. Check S3_BUCKET, and create the bucket if it has not been created yet.',
  },
  {
    codes: ['AccessDenied', 'AllAccessDisabled'],
    code: 'access_denied',
    message:
      'Object storage denied access to the bucket. The credentials are valid but are not allowed to write here — grant s3:PutObject on this bucket. Some providers also return this when the bucket does not exist.',
  },
  {
    codes: ['PermanentRedirect', 'AuthorizationHeaderMalformed', 'IllegalLocationConstraintException'],
    code: 'region_mismatch',
    message:
      'Object storage reported a region mismatch for the bucket. Check that S3_REGION matches the region the bucket was created in.',
  },
  {
    codes: ['RequestTimeTooSkewed'],
    code: 'clock_skew',
    message:
      'Object storage rejected the request because the API server clock is too far from the storage provider clock. Check time sync (NTP) on the API host.',
  },
  {
    codes: ['ECONNREFUSED'],
    code: 'endpoint_refused',
    message:
      'The API server could not connect to the object storage endpoint (connection refused). Check the host and port in S3_ENDPOINT and that the storage service is running.',
  },
  {
    codes: ['ENOTFOUND', 'EAI_AGAIN'],
    code: 'endpoint_dns',
    message:
      'The object storage endpoint hostname could not be resolved. Check S3_ENDPOINT for a typo, and that the name resolves from inside the API container.',
  },
  {
    codes: ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'TimeoutError', 'RequestTimeout'],
    code: 'endpoint_unreachable',
    message:
      'The connection to object storage timed out or was reset. Check network reachability and any firewall between the API server and S3_ENDPOINT.',
  },
  {
    codes: [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'EPROTO',
    ],
    code: 'endpoint_tls',
    message:
      'The TLS connection to object storage failed. If the endpoint uses a private or self-signed certificate, add its CA to the API container trust store; also check whether S3_ENDPOINT should be http:// rather than https://.',
  },
];

/** Codes only recognisable by prefix, e.g. every OpenSSL `CERT_*` variant. */
const TLS_CODE_PREFIXES = ['CERT_'] as const;

/**
 * Collect every plausible error code from an error and its `cause` chain. The
 * SDK surfaces service faults on `name`/`Code` but wraps socket and TLS faults,
 * where the useful code sits on `code` one or more levels down.
 */
function collectErrorCodes(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== 'object' || depth > 4) return [];
  const e = err as { name?: unknown; code?: unknown; Code?: unknown; cause?: unknown };
  const own: string[] = [];
  for (const raw of [e.name, e.code, e.Code]) {
    if (typeof raw === 'string' && raw !== '') own.push(raw);
  }
  return [...own, ...collectErrorCodes(e.cause, depth + 1)];
}

function findHttpStatus(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== 'object' || depth > 4) return undefined;
  const e = err as { $metadata?: { httpStatusCode?: unknown }; cause?: unknown };
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number') return status;
  return findHttpStatus(e.cause, depth + 1);
}

/**
 * Provider error codes are a fixed vocabulary, not user or credential data, so
 * echoing one is safe — but clamp the shape anyway so a hostile or malformed
 * value can't inject newlines into a log line or smuggle text into a response.
 */
function sanitizeCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const cleaned = code.replace(/[^A-Za-z0-9_.:-]/g, '');
  return cleaned === '' ? undefined : cleaned.slice(0, 64);
}

/**
 * Map an object storage failure onto an operator-actionable hint.
 *
 * The returned message is deliberately built from curated strings plus (at
 * most) a sanitized provider error code. It never includes the raw SDK/provider
 * message: `SignatureDoesNotMatch` and `AccessDenied` responses can echo the
 * access key id and the string-to-sign, and this text is returned to an API
 * caller.
 */
export function classifyS3Failure(err: unknown): S3FailureClassification {
  const codes = collectErrorCodes(err);

  for (const candidate of codes) {
    const rule = S3_FAILURE_RULES.find((r) => r.codes.includes(candidate));
    if (rule) return { code: rule.code, message: rule.message };
    if (TLS_CODE_PREFIXES.some((prefix) => candidate.startsWith(prefix))) {
      const tls = S3_FAILURE_RULES.find((r) => r.code === 'endpoint_tls')!;
      return { code: 'endpoint_tls', message: tls.message };
    }
  }

  const httpStatus = findHttpStatus(err);
  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return {
      code: 'provider_error',
      message: `Object storage returned a server error (HTTP ${httpStatus}). The storage provider is unhealthy or throttling; check its own logs.`,
    };
  }

  // `name` is first in the collected list, so it is the most descriptive code
  // available for an unmapped fault (e.g. MinIO's XMinio* codes).
  const label = sanitizeCode(codes.find((c) => c !== 'Error' && c !== 'TypeError'));
  return {
    code: 'unknown',
    message: label
      ? `Object storage rejected the request (${label}). Check the API server logs for the full error.`
      : 'Object storage rejected the request for an unrecognized reason. Check the API server logs for the full error.',
  };
}

/**
 * Bucket + endpoint HOST for log lines. `URL.host` intentionally drops any
 * userinfo, path, and query, so an endpoint carrying embedded credentials or a
 * signed URL cannot leak through this.
 */
function describeS3Endpoint(): string {
  const raw = process.env.S3_ENDPOINT;
  if (!raw) return 'aws-default';
  try {
    const coerced = coerceS3EndpointUrl(raw);
    return coerced ? new URL(coerced).host : 'aws-default';
  } catch {
    return 'unparseable';
  }
}

/**
 * Log an object storage fault with enough context to grep for in
 * `docker logs breeze-api`, then wrap it for the caller.
 *
 * What is logged: our failure code, the sanitized provider code, the HTTP
 * status, the bucket, the endpoint host, and the key PREFIX. What is
 * deliberately not logged: the raw provider message (can echo the access key
 * id and string-to-sign) and the object's final path segment (an
 * operator-supplied filename, i.e. untrusted log input). The original error is
 * preserved as `cause` so Sentry still receives full detail.
 */
function wrapS3Failure(
  operation: string,
  bucket: string,
  s3Key: string,
  err: unknown
): S3OperationError {
  const classification = classifyS3Failure(err);
  const providerCode = sanitizeCode(collectErrorCodes(err).find((c) => c !== 'Error')) ?? 'unknown';
  const httpStatus = findHttpStatus(err) ?? 'none';
  const keyPrefix = s3Key.slice(0, s3Key.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9_./:-]/g, '');
  // S3_BUCKET is operator-set rather than request input, but it lands in the
  // same log line as the sanitized fields — clamp it identically so no env
  // value can break the line format.
  const safeBucket = bucket.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);

  console.error(
    `[s3Storage] ${operation} failed: reason=${classification.code} ` +
      `providerCode=${providerCode} httpStatus=${httpStatus} ` +
      `bucket=${safeBucket} endpoint=${describeS3Endpoint()} keyPrefix=${keyPrefix}`
  );

  return new S3OperationError(operation, classification, err);
}

async function computeFileChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest('hex');
}

async function getRemoteObjectState(
  bucket: string,
  key: string
): Promise<{ exists: boolean; checksum: string | null; size: number | null }> {
  try {
    const client = getS3Client();
    const resp = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      exists: true,
      checksum: resp.Metadata?.sha256 ?? null,
      size: typeof resp.ContentLength === 'number' ? resp.ContentLength : null,
    };
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === 'NotFound' || code === 'NoSuchKey') {
      return { exists: false, checksum: null, size: null };
    }
    throw err;
  }
}

export async function uploadBinary(localPath: string, s3Key: string, checksum?: string): Promise<void> {
  const bucket = requireBucket();
  const client = getS3Client();
  const body = createReadStream(localPath);
  const stat = statSync(localPath);

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: body,
        ContentLength: stat.size,
        ContentType: 'application/octet-stream',
        Metadata: checksum ? { sha256: checksum } : undefined,
      })
    );
  } catch (err) {
    // Bare `client.send` used to let every storage fault reach the global error
    // handler as an opaque 500 (#2794). Classify + log here so both the API
    // caller and `docker logs breeze-api` get something actionable.
    throw wrapS3Failure('uploadBinary', bucket, s3Key, err);
  }
}

let presignTtlWarned = false;

export async function getPresignedUrl(s3Key: string, ttlSeconds?: number): Promise<string> {
  const bucket = requireBucket();
  const client = getS3Client();
  const rawTtl = parseInt(process.env.S3_PRESIGN_TTL || '900', 10);
  if (process.env.S3_PRESIGN_TTL && (!Number.isFinite(rawTtl) || rawTtl <= 0) && !presignTtlWarned) {
    console.warn(`[s3Storage] Invalid S3_PRESIGN_TTL="${process.env.S3_PRESIGN_TTL}", using default 900`);
    presignTtlWarned = true;
  }
  const ttl = ttlSeconds ?? (Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 900);

  // Presigned URLs are valid even for non-existent keys, so verify first
  await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));

  return (getSignedUrl as any)(client, new GetObjectCommand({ Bucket: bucket, Key: s3Key }), {
    expiresIn: ttl,
  });
}

export interface SyncResult {
  uploaded: number;
  skipped: number;
  errors: string[];
}

export async function syncDirectory(localDir: string, s3Prefix: string): Promise<SyncResult> {
  const bucket = requireBucket();
  const result: SyncResult = { uploaded: 0, skipped: 0, errors: [] };

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(localDir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to read directory ${localDir}: ${msg}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const filePath = join(localDir, entry.name);
    const s3Key = `${s3Prefix}/${entry.name}`;

    try {
      const localChecksum = await computeFileChecksum(filePath);
      const localSize = statSync(filePath).size;
      const remote = await getRemoteObjectState(bucket, s3Key);

      if (remote.exists && remote.checksum === localChecksum && remote.size === localSize) {
        result.skipped++;
        continue;
      }

      await uploadBinary(filePath, s3Key, localChecksum);
      result.uploaded++;
    } catch (err) {
      result.errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
