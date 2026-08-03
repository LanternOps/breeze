/**
 * Chunked software package uploader (issue #2951).
 *
 * Drives the upload-session API: create session → PUT chunks (each its own
 * short request carrying a fresh access token, so the 15-minute token TTL
 * never binds the total upload time) → complete.
 *
 * Resolution contract (lets callers keep their existing Response handling):
 *  - resolves with the /complete Response (201) on success;
 *  - resolves with the FIRST unrecoverable failing Response (body carries
 *    `{ error }`, so runAction / `response.ok` checks surface the real server
 *    message);
 *  - rejects only on network failure (after per-chunk retries) or abort.
 *
 * Recovery:
 *  - transient failures (network error, 429/5xx) retry a chunk up to
 *    MAX_CHUNK_ATTEMPTS with linear backoff;
 *  - a 409 carries the server's authoritative bytesReceived — the loop
 *    resyncs and re-slices from there (duplicate chunks are idempotent
 *    server-side); repeated 409s that fail to raise the high-water mark bail
 *    out (MAX_STALLED_RESYNCS), and a non-resetting total-resync budget
 *    (MAX_TOTAL_RESYNCS) backstops slow-drip / ping-pong patterns that would
 *    otherwise dodge the consecutive counter;
 *  - a 409 with error 'upload_instance_mismatch' is TERMINAL: the upload
 *    aborts immediately (no retries) with an operator-actionable message —
 *    the API restarted, or a load balancer without session affinity is
 *    spraying chunks across replicas.
 *
 * create and /complete each get their own generous, explicit timeout ceiling
 * (see CREATE_TIMEOUT_MS / COMPLETE_TIMEOUT_MS) combined with any
 * caller-supplied signal. This matters because fetchWithAuth only applies its
 * own DEFAULT_TIMEOUT_MS (30s) when NO signal is passed at all — a caller
 * signal (Tasks 11/12 wire the modal's cancel button to one) otherwise
 * disables timeout enforcement entirely. /complete is the step where the
 * server stats the assembled file, hashes it, and pushes it to S3/MinIO —
 * comfortably past 30s for the large packages this feature exists for.
 */
import { fetchWithAuth } from '../stores/auth';
import type { DetectionRule } from '@breeze/shared';

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // default target; overridden if the server returns a different `chunkSize` from session create
const CHUNK_TIMEOUT_MS = 5 * 60_000; // generous floor: 8MB in 5min ≈ 0.2 Mbps uplink
// Session create is a small metadata write (validate + insert one row). 30s
// matches fetchWithAuth's own previous implicit default — this just makes it
// explicit so a caller-supplied signal can no longer silently remove it.
const CREATE_TIMEOUT_MS = 30_000;
// /complete does server-side-only work: stat the assembled temp file, hash it
// (sha256 over the whole file), and push it to S3/MinIO. That's bounded by
// server disk + object-storage throughput, not the client's uplink (chunks
// are already delivered by this point). 10 minutes gives a several-hundred-MB
// package comfortable headroom even against a degraded storage backend, while
// still failing well before a user assumes the browser hung.
const COMPLETE_TIMEOUT_MS = 10 * 60_000;
const MAX_CHUNK_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
// Consecutive resyncs that fail to raise the high-water mark — reset only
// when a resync actually advances past every offset previously observed, so
// an alternating/regressing pattern (e.g. a "lost state" 409 that bounces
// bytesReceived back to 0) can't dodge this by re-touching a smaller offset.
const MAX_STALLED_RESYNCS = 3;
// Non-resetting backstop over the ENTIRE upload: caps total 409 resyncs even
// if each one nudges the high-water mark forward by a little (a slow-drip
// pattern that would never trip the consecutive counter above).
const MAX_TOTAL_RESYNCS = 20;

export interface PackageVersionMetadata {
  version: string;
  architecture?: string;
  releaseNotes?: string;
  silentInstallArgs?: string;
  silentUninstallArgs?: string;
  downloadUrl?: string;
  supportedOs?: string[];
  detectionRules?: DetectionRule[];
}

export interface UploadPackageVersionOptions {
  catalogId: string;
  file: File;
  metadata: PackageVersionMetadata;
  /** Called after every acknowledged chunk with cumulative bytes on the server. */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const forward = (s: AbortSignal) => () => controller.abort(s.reason);
  if (a.aborted) controller.abort(a.reason);
  else a.addEventListener('abort', forward(a), { once: true });
  if (b.aborted) controller.abort(b.reason);
  else b.addEventListener('abort', forward(b), { once: true });
  return controller.signal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ChunkOutcome =
  | { kind: 'advanced'; bytesReceived: number; resynced: boolean }
  | { kind: 'failed'; response: Response };

async function sendChunk(
  catalogId: string,
  uploadId: string,
  chunk: Blob,
  offset: number,
  signal: AbortSignal | undefined,
): Promise<ChunkOutcome> {
  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetchWithAuth(
        `/software/catalog/${catalogId}/versions/uploads/${uploadId}/chunks?offset=${offset}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          signal: combineSignals(signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)),
        },
      );
    } catch (err) {
      if (signal?.aborted) throw err; // user abort — never retry
      lastNetworkError = err;
      if (attempt === MAX_CHUNK_ATTEMPTS) throw err;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (response.ok) {
      // clone(): leave `response` itself unconsumed. If the body turns out to
      // be malformed we return `response` as the FAILED outcome, and the
      // caller (runAction) must still be able to read its body — reading it
      // here directly would hand back an already-consumed Response and a
      // genuine failure would be reported to the user as success.
      const body = (await response.clone().json().catch(() => null)) as
        | { data?: { bytesReceived?: number } }
        | null;
      const bytesReceived = body?.data?.bytesReceived;
      if (typeof bytesReceived !== 'number') return { kind: 'failed', response };
      return { kind: 'advanced', bytesReceived, resynced: false };
    }
    if (response.status === 409) {
      const body = (await response.clone().json().catch(() => null)) as
        | { error?: string; bytesReceived?: number }
        | null;
      if (body?.error === 'upload_instance_mismatch') {
        // TERMINAL (Tasks 6-7 contract): another API process owns this
        // upload's temp file — the API restarted, or requests are being
        // load-balanced across replicas without session affinity. Retrying
        // or resyncing can never succeed; fail immediately with an
        // operator-actionable message.
        return {
          kind: 'failed',
          response: new Response(
            JSON.stringify({
              error:
                'Upload cannot continue: it was started on a different API server instance ' +
                '(the API restarted, or requests are load-balanced across replicas without ' +
                'session affinity). Enable sticky sessions for the API — or run a single ' +
                'replica — then start the upload again.',
              code: 'upload_instance_mismatch',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
        };
      }
      if (typeof body?.bytesReceived === 'number') {
        // Resync: the outer loop re-slices from the authoritative offset.
        return { kind: 'advanced', bytesReceived: body.bytesReceived, resynced: true };
      }
      return { kind: 'failed', response };
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_CHUNK_ATTEMPTS) return { kind: 'failed', response };
      await sleep(RETRY_BASE_DELAY_MS * attempt);
      continue;
    }
    // Other 4xx: unrecoverable (401 refresh/replay already happened inside
    // fetchWithAuth; 404 session gone; 413 size bug).
    return { kind: 'failed', response };
  }
  throw lastNetworkError instanceof Error
    ? lastNetworkError
    : new Error('Chunk upload failed after retries');
}

function stalledResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function uploadPackageVersion(
  opts: UploadPackageVersionOptions,
): Promise<Response> {
  const { catalogId, file, metadata, onProgress, signal } = opts;

  const createResponse = await fetchWithAuth(
    `/software/catalog/${catalogId}/versions/uploads`,
    {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        chunkSize: UPLOAD_CHUNK_SIZE,
        ...metadata,
      }),
      signal: combineSignals(signal, AbortSignal.timeout(CREATE_TIMEOUT_MS)),
    },
  );
  if (!createResponse.ok) return createResponse;

  const created = (await createResponse.json().catch(() => null)) as
    | { data?: { uploadId?: string; bytesReceived?: number; chunkSize?: number } }
    | null;
  const uploadId = created?.data?.uploadId;
  if (!uploadId) throw new Error('Upload session did not return an uploadId');

  // The server validates the requested chunkSize against its own MIN/MAX and
  // may echo back a different value; adopt it, or every subsequent chunk
  // request would be sized for a session the server never agreed to (a
  // guaranteed 413 loop if the server's floor/ceiling ever differs from ours).
  const chunkSize =
    typeof created?.data?.chunkSize === 'number' && created.data.chunkSize > 0
      ? created.data.chunkSize
      : UPLOAD_CHUNK_SIZE;

  let offset = created?.data?.bytesReceived ?? 0;
  onProgress?.(offset, file.size);

  let highWaterMark = offset;
  let stalledResyncs = 0;
  let totalResyncs = 0;

  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
    const outcome = await sendChunk(catalogId, uploadId, chunk, offset, signal);
    if (outcome.kind === 'failed') return outcome.response;

    if (outcome.resynced) {
      totalResyncs += 1;
      if (totalResyncs > MAX_TOTAL_RESYNCS) {
        return stalledResponse(
          'Upload could not make progress after repeated resyncs; please retry',
        );
      }
    }

    if (outcome.bytesReceived > highWaterMark) {
      highWaterMark = outcome.bytesReceived;
      stalledResyncs = 0;
    } else {
      // Doesn't move the high-water mark forward — including a regression
      // (server reports fewer bytes than it previously acknowledged, e.g.
      // "Upload state lost; restart from offset 0"). A few of these can be
      // normal after a lost response; endless or ping-ponging ones mean the
      // server can never durably accept our progress — bail out with a
      // synthetic 409 the caller can surface.
      stalledResyncs += 1;
      if (stalledResyncs > MAX_STALLED_RESYNCS) {
        return stalledResponse('Upload could not make progress; please retry');
      }
    }
    offset = outcome.bytesReceived;
    onProgress?.(offset, file.size);
  }

  return fetchWithAuth(
    `/software/catalog/${catalogId}/versions/uploads/${uploadId}/complete`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      signal: combineSignals(signal, AbortSignal.timeout(COMPLETE_TIMEOUT_MS)),
    },
  );
}
