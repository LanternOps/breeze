import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '../stores/auth';
import { uploadPackageVersion, UPLOAD_CHUNK_SIZE } from './softwarePackageUpload';

const fetchMock = vi.mocked(fetchWithAuth);

// Models real Fetch Response body-consumption semantics: json() can only be
// read once per instance, and clone() must be called BEFORE the body is
// consumed, returning an INDEPENDENTLY-consumable instance. This matters
// because a prior version of the test suite's fake (`clone: () => res` +
// repeatable `mockResolvedValue`) made double body-consumption bugs
// structurally impossible to observe — see #2951 Task 10 review Finding 4.
function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  let used = false;
  const instance = {
    ok,
    status,
    get bodyUsed() {
      return used;
    },
    json: vi.fn(async () => {
      if (used) throw new TypeError('Body has already been read');
      used = true;
      return payload;
    }),
    clone: () => {
      if (used) throw new TypeError('Cannot clone a body which is already used');
      return jsonResponse(payload, ok, status);
    },
  };
  return instance as unknown as Response;
}

// UPLOAD_CHUNK_SIZE is fixed at 8MB, so use small files (< one chunk); the
// chunk-loop mechanics (offsets, resync, retry) are fully exercised anyway.
function makeFile(bytes: number, name = 'big.msi'): File {
  const blob = new Uint8Array(bytes);
  return new File([blob], name, { type: 'application/octet-stream' });
}

const CATALOG_ID = 'cat-1';
const baseMeta = { version: '1.2.3', architecture: 'x64' };

describe('uploadPackageVersion', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('drives create → chunk → complete and reports byte-accurate progress', async () => {
    const file = makeFile(10);
    const progress: Array<[number, number]> = [];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({
      catalogId: CATALOG_ID,
      file,
      metadata: baseMeta,
      onProgress: (sent, total) => progress.push([sent, total]),
    });

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [createUrl, createOpts] = fetchMock.mock.calls[0];
    expect(createUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads`);
    expect(JSON.parse(createOpts!.body as string)).toMatchObject({
      fileName: 'big.msi',
      fileSize: 10,
      chunkSize: UPLOAD_CHUNK_SIZE,
      version: '1.2.3',
    });

    const [chunkUrl, chunkOpts] = fetchMock.mock.calls[1];
    expect(chunkUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1/chunks?offset=0`);
    expect(chunkOpts!.method).toBe('PUT');
    expect((chunkOpts!.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');

    const [completeUrl, completeOpts] = fetchMock.mock.calls[2];
    expect(completeUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1/complete`);
    expect(completeOpts!.method).toBe('POST');

    expect(progress).toEqual([[0, 10], [10, 10]]);
  });

  it('resyncs to the server-reported offset on a 409', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      // chunk at offset 0 → 409, server already has 4 bytes
      .mockResolvedValueOnce(jsonResponse({ error: 'offset mismatch', bytesReceived: 4 }, false, 409))
      // resynced chunk at offset 4 → done
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(201);
    expect(fetchMock.mock.calls[2][0]).toBe(
      `/software/catalog/${CATALOG_ID}/versions/uploads/u-1/chunks?offset=4`,
    );
  });

  it('retries a chunk on a transient 5xx, then succeeds', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 502))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 15_000);

  it('resolves with the failing response when the create call is rejected (runAction parses it)', async () => {
    const file = makeFile(10, 'bad.zip');
    const failing = jsonResponse({ error: 'Unsupported file type: .zip' }, false, 400);
    fetchMock.mockResolvedValueOnce(failing);

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res).toBe(failing);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves with the failing response when a chunk 4xx is unrecoverable', async () => {
    const file = makeFile(10);
    const failing = jsonResponse({ error: 'Upload session not found' }, false, 404);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(failing);

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res).toBe(failing);
  });

  it('treats upload_instance_mismatch as terminal: one attempt, no retries, actionable message, and releases the session', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'upload_instance_mismatch', message: 'other instance', bytesReceived: 0 },
          false,
          409,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true })); // session-release DELETE

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('upload_instance_mismatch');
    expect(body.error).toMatch(/session affinity|sticky|single/i);
    // create + ONE chunk attempt + the best-effort session-release DELETE —
    // no retry burn, no resync loop, and /complete was never called.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [deleteUrl, deleteOpts] = fetchMock.mock.calls[2];
    expect(deleteUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1`);
    expect(deleteOpts!.method).toBe('DELETE');
  });

  it('gives up after repeated 409s that do not advance (stall guard), and releases the session', async () => {
    const file = makeFile(10);
    const stuck = () => jsonResponse({ error: 'offset mismatch', bytesReceived: 0 }, false, 409);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(jsonResponse({ success: true })); // session-release DELETE

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const [deleteUrl, deleteOpts] = fetchMock.mock.calls[5];
    expect(deleteUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1`);
    expect(deleteOpts!.method).toBe('DELETE');
  });

  // --- Fix round 1 (review findings) -------------------------------------

  it('gives create and /complete their own timeout ceiling, independent of any caller signal', async () => {
    const file = makeFile(10);
    const callerController = new AbortController();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    await uploadPackageVersion({
      catalogId: CATALOG_ID,
      file,
      metadata: baseMeta,
      signal: callerController.signal,
    });

    const [, createOpts] = fetchMock.mock.calls[0];
    const [, completeOpts] = fetchMock.mock.calls[2];
    // A combined signal, not a raw pass-through of the caller's signal — the
    // ceiling must apply even when the caller also supplies one.
    expect(createOpts!.signal).toBeInstanceOf(AbortSignal);
    expect(createOpts!.signal).not.toBe(callerController.signal);
    expect(completeOpts!.signal).toBeInstanceOf(AbortSignal);
    expect(completeOpts!.signal).not.toBe(callerController.signal);
  });

  it('still propagates a caller abort through the combined create-call signal', async () => {
    const file = makeFile(10);
    const callerController = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const sig = (options as { signal?: AbortSignal } | undefined)?.signal;
          sig?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

    const promise = uploadPackageVersion({
      catalogId: CATALOG_ID,
      file,
      metadata: baseMeta,
      signal: callerController.signal,
    });
    callerController.abort();

    await expect(promise).rejects.toThrow();
  });

  // --- Fix round 2 (final pre-merge review, #2951) -----------------------

  it('Fix 2: synthesizes a non-ok Response when a 200 chunk ack has a malformed body', async () => {
    const file = makeFile(10);
    const malformedAck = jsonResponse({ data: {} }, true, 200); // ok, but missing bytesReceived
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(malformedAck)
      .mockResolvedValueOnce(jsonResponse({ success: true })); // session-release DELETE

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    // Must NOT be the raw 200 ack: SoftwareVersionManager gates only on
    // `!response.ok`, and AddPackageModal hands the body to
    // `isApiFailure(data, 200)` — both would read a bare 200 as SUCCESS and
    // report a phantom completed upload (the bug this fix closes).
    expect(res).not.toBe(malformedAck);
    expect(res.ok).toBe(false);
    expect(res.status).not.toBe(200);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('releases the session after a malformed-200 chunk ack (it is a terminal failure)', async () => {
    const file = makeFile(10);
    const malformedAck = jsonResponse({ data: {} }, true, 200);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(malformedAck)
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [deleteUrl, deleteOpts] = fetchMock.mock.calls[2];
    expect(deleteUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1`);
    expect(deleteOpts!.method).toBe('DELETE');
  });

  // --- Fix round 3 (final pre-merge review, #2951, Finding 1) -------------
  // A cancelled or failed upload must release its server-side session so it
  // doesn't pin a slot against MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER for hours.

  it('releases the upload session on a caller abort, without the aborted signal on the DELETE', async () => {
    const file = makeFile(10);
    const callerController = new AbortController();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            const abortErr = new DOMException('Aborted', 'AbortError');
            const sig = (options as { signal?: AbortSignal } | undefined)?.signal;
            // Handle both orderings: the signal is already aborted by the
            // time this executor runs (no future 'abort' event will ever
            // fire again), or it aborts later while this fetch is pending.
            if (sig?.aborted) {
              reject(abortErr);
              return;
            }
            sig?.addEventListener('abort', () => reject(abortErr));
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true })); // session-release DELETE

    const promise = uploadPackageVersion({
      catalogId: CATALOG_ID,
      file,
      metadata: baseMeta,
      signal: callerController.signal,
    });
    // Defer the abort to a macrotask so it lands AFTER the create call has
    // resolved and the chunk PUT (whose listener we depend on above) has
    // actually been issued — a synchronous abort() here would fire before
    // the chunk fetch is even called.
    setTimeout(() => callerController.abort(), 0);

    await expect(promise).rejects.toThrow();
    // create, the aborted chunk PUT, and the release DELETE.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [deleteUrl, deleteOpts] = fetchMock.mock.calls[2];
    expect(deleteUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1`);
    expect(deleteOpts!.method).toBe('DELETE');
    // The already-aborted caller signal must NOT be reused for the DELETE —
    // reusing it would abort the release request before it ever reaches the
    // network, defeating the whole point of the release.
    expect(deleteOpts!.signal).not.toBe(callerController.signal);
    expect((deleteOpts!.signal as AbortSignal | undefined)?.aborted).toBe(false);
  });

  it('does not change the caller-visible outcome when the release DELETE itself fails (best-effort)', async () => {
    const file = makeFile(10);
    const failing = jsonResponse({ error: 'Upload session not found' }, false, 404);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(failing)
      .mockRejectedValueOnce(new Error('network blip during session release'));

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    // The caller still gets the ORIGINAL unrecoverable chunk failure, not an
    // error surfaced from the (fully swallowed) release attempt.
    expect(res).toBe(failing);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not issue a DELETE after a successful complete', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(201);
    // Exactly create + chunk + complete — the server already deletes the
    // session row inside /complete, so a second DELETE here would be
    // harmless but pointless.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
  });

  it('releases the session when /complete itself returns a failing response', async () => {
    const file = makeFile(10);
    const completeFailure = jsonResponse({ error: 'S3 upload failed', storageFailure: 'boom' }, false, 502);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(completeFailure)
      .mockResolvedValueOnce(jsonResponse({ success: true })); // session-release DELETE

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res).toBe(completeFailure);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [deleteUrl, deleteOpts] = fetchMock.mock.calls[3];
    expect(deleteUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1`);
    expect(deleteOpts!.method).toBe('DELETE');
  });

  it('gives up on an alternating high/low resync pattern that a naive consecutive-only counter would never catch', async () => {
    const file = makeFile(300);
    const resync = (bytesReceived: number) =>
      jsonResponse({ error: 'offset mismatch', bytesReceived }, false, 409);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(resync(100)) // advances high-water mark to 100
      .mockResolvedValueOnce(resync(0)) // regresses — "lost state" style
      .mockResolvedValueOnce(resync(100)) // back to the same high-water mark — NOT a new high
      .mockResolvedValueOnce(resync(0)) // regresses again
      .mockResolvedValueOnce(resync(100)) // 4th non-advancing resync in a row by high-water accounting — bail
      .mockResolvedValueOnce(jsonResponse({ success: true })); // session-release DELETE

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(409);
    // create + 5 chunk attempts + the session-release DELETE — /complete is
    // never reached.
    expect(fetchMock).toHaveBeenCalledTimes(7);
    const [deleteUrl, deleteOpts] = fetchMock.mock.calls[6];
    expect(deleteUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1`);
    expect(deleteOpts!.method).toBe('DELETE');
  });

  it('adopts the server-returned chunkSize instead of hardcoding the local constant', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: 5 } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 5 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(201);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `/software/catalog/${CATALOG_ID}/versions/uploads/u-1/chunks?offset=0`,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `/software/catalog/${CATALOG_ID}/versions/uploads/u-1/chunks?offset=5`,
    );
  });
});
