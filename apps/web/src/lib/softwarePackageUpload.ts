/**
 * Chunked software package uploader (issue #2951).
 *
 * Drives the upload-session API: create session → PUT 8MB chunks (each its
 * own short request carrying a fresh access token, so the 15-minute token TTL
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
 *    server-side); repeated 409s with no forward progress bail out;
 *  - a 409 with error 'upload_instance_mismatch' is TERMINAL: the upload
 *    aborts immediately (no retries) with an operator-actionable message —
 *    the API restarted, or a load balancer without session affinity is
 *    spraying chunks across replicas.
 */
import { fetchWithAuth } from '../stores/auth';
import type { DetectionRule } from '@breeze/shared';

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // keep in sync with API MAX_CHUNK_SIZE
const CHUNK_TIMEOUT_MS = 5 * 60_000; // generous floor: 8MB in 5min ≈ 0.2 Mbps uplink
const MAX_CHUNK_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const MAX_STALLED_RESYNCS = 3;

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
  | { kind: 'advanced'; bytesReceived: number }
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
      const body = (await response.json().catch(() => null)) as
        | { data?: { bytesReceived?: number } }
        | null;
      const bytesReceived = body?.data?.bytesReceived;
      if (typeof bytesReceived !== 'number') return { kind: 'failed', response };
      return { kind: 'advanced', bytesReceived };
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
        return { kind: 'advanced', bytesReceived: body.bytesReceived };
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
      signal,
    },
  );
  if (!createResponse.ok) return createResponse;

  const created = (await createResponse.json().catch(() => null)) as
    | { data?: { uploadId?: string; bytesReceived?: number } }
    | null;
  const uploadId = created?.data?.uploadId;
  if (!uploadId) throw new Error('Upload session did not return an uploadId');

  let offset = created?.data?.bytesReceived ?? 0;
  onProgress?.(offset, file.size);

  let stalledResyncs = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, file.size));
    const outcome = await sendChunk(catalogId, uploadId, chunk, offset, signal);
    if (outcome.kind === 'failed') return outcome.response;

    if (outcome.bytesReceived <= offset) {
      // 409 resync that moved us backwards/nowhere. A few of these are normal
      // after a lost response; endless ones mean the server can never accept
      // our offset — bail out with a synthetic 409 the caller can surface.
      stalledResyncs += 1;
      if (stalledResyncs > MAX_STALLED_RESYNCS) {
        return new Response(
          JSON.stringify({ error: 'Upload could not make progress; please retry' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
    } else {
      stalledResyncs = 0;
    }
    offset = outcome.bytesReceived;
    onProgress?.(offset, file.size);
  }

  return fetchWithAuth(
    `/software/catalog/${catalogId}/versions/uploads/${uploadId}/complete`,
    { method: 'POST', body: JSON.stringify({}), signal },
  );
}
