import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '../stores/auth';
import { uploadPackageVersion, UPLOAD_CHUNK_SIZE } from './softwarePackageUpload';

const fetchMock = vi.mocked(fetchWithAuth);

// clone() returns the same object: sendChunk inspects 409 bodies via
// response.clone().json() before deciding resync vs terminal.
const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response => {
  const res = {
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
    clone: () => res,
  };
  return res as unknown as Response;
};

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

  it('treats upload_instance_mismatch as terminal: one attempt, no retries, actionable message', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'upload_instance_mismatch', message: 'other instance', bytesReceived: 0 },
          false,
          409,
        ),
      );

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('upload_instance_mismatch');
    expect(body.error).toMatch(/session affinity|sticky|single/i);
    // Exactly create + ONE chunk attempt — no retry burn, no resync loop,
    // and /complete was never called.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated 409s that do not advance (stall guard)', async () => {
    const file = makeFile(10);
    const stuck = () => jsonResponse({ error: 'offset mismatch', bytesReceived: 0 }, false, 409);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck());

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(409);
  });
});
