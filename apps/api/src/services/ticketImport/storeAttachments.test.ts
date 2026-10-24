/**
 * The store step of an imported attachment (#8313 W1; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §4.3 step 2, §4.4): permanent failures skip the file and put nothing;
 * transient ones fail the ticket (503) and keep the reservation; the byte
 * bucket is charged before the download.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const putBytesMock = vi.hoisted(() => vi.fn());
vi.mock('../ticketAttachmentStorage', () => ({
  putBytes: putBytesMock,
  objectKeyFor: (id: string) => `ticket-attachments/${id}`,
}));
vi.mock('../../db', () => ({ db: {} }));

import { MigrationWindowError } from '../migrationWindows';
import { ImportAttachmentFetchError, storeReservedAttachment } from './storeAttachments';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 7)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)]);
const MZ = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(62, 0)]);
const MIB = 1024 * 1024;

function run(fetchAttachment: (id: string, max: number) => Promise<Uint8Array>, declaredBytes?: number, pending = true) {
  const chargeBytes = vi.fn(async () => undefined);
  const stillPending = vi.fn(async () => pending);
  const promise = storeReservedAttachment({
    id: ID, sourceId: 'zammad-store-7', ...(declaredBytes !== undefined ? { declaredBytes } : {}), fetchAttachment, chargeBytes, stillPending,
  });
  return { promise, chargeBytes, stillPending };
}

beforeEach(() => {
  putBytesMock.mockReset();
  putBytesMock.mockResolvedValue({ backend: 's3', storageKey: `ticket-attachments/${ID}`, data: null });
});

describe('storeReservedAttachment', () => {
  it('charges the declared size, fetches at most 10 MiB, and puts the sniffed type and the digest to the reserved key', async () => {
    const fetch = vi.fn(async () => PNG);
    const { promise, chargeBytes } = run(fetch, PNG.length);
    const outcome = await promise;
    const sha = createHash('sha256').update(PNG).digest('hex');
    expect(chargeBytes).toHaveBeenCalledWith(PNG.length);
    expect(fetch).toHaveBeenCalledWith('zammad-store-7', 10 * MIB);
    expect(putBytesMock).toHaveBeenCalledWith(ID, PNG, 'image/png', sha);
    expect(outcome).toEqual({ kind: 'stored', claim: { id: ID, contentType: 'image/png', byteSize: PNG.length, sha256: sha } });
  });

  it('stores anything outside the allowlist as application/octet-stream, and accepts a plain Uint8Array', async () => {
    const outcome = await run(async () => new Uint8Array(ZIP)).promise;
    expect(outcome).toMatchObject({ kind: 'stored', claim: { contentType: 'application/octet-stream', byteSize: ZIP.length } });
    expect(putBytesMock.mock.calls[0]![1]).toEqual(ZIP);
  });

  it('charges the cap when the source declared no size', async () => {
    const { promise, chargeBytes } = run(async () => ZIP);
    await promise;
    expect(chargeBytes).toHaveBeenCalledWith(10 * MIB);
  });

  it('a refused byte charge propagates before anything is fetched', async () => {
    const fetch = vi.fn(async () => PNG);
    const chargeBytes = vi.fn(async () => {
      throw new MigrationWindowError('MIGRATION_WINDOW_RATE_LIMITED', 'limit', 429, { kind: 'bytes', retryAfterSeconds: 30 });
    });
    await expect(storeReservedAttachment({ id: ID, sourceId: 's', fetchAttachment: fetch, chargeBytes, stillPending: async () => true }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_RATE_LIMITED', details: { kind: 'bytes' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'not_found'],
    ['too_large', 'too_large'],
  ] as const)('a permanent %s from the source skips the file and puts nothing', async (failure, reason) => {
    const outcome = await run(async () => { throw new ImportAttachmentFetchError(failure); }).promise;
    expect(outcome).toEqual({ kind: 'skipped', reason });
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('bytes over the cap are too_large, none are empty, and an executable header is blocked_type, whatever the source said', async () => {
    expect(await run(async () => Buffer.alloc(10 * MIB + 1, 1)).promise).toEqual({ kind: 'skipped', reason: 'too_large' });
    expect(await run(async () => Buffer.alloc(0)).promise).toEqual({ kind: 'skipped', reason: 'empty' });
    expect(await run(async () => MZ).promise).toEqual({ kind: 'skipped', reason: 'blocked_type' });
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a transient ImportAttachmentFetchError', new ImportAttachmentFetchError('transient')],
    ['any other error (a timeout, a 5xx after retries)', new Error('socket hang up')],
  ])('%s fails the ticket with 503 TICKET_IMPORT_ATTACHMENT_UNAVAILABLE and is never a skip', async (_name, error) => {
    const err = await run(async () => { throw error; }).promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationWindowError);
    expect(err).toMatchObject({ code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE', status: 503, details: { attachmentSourceId: 'zammad-store-7', stage: 'fetch' } });
    expect((err as Error).cause).toBe(error);
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('a storage fault is transient too', async () => {
    const fault = new Error('S3 down');
    putBytesMock.mockRejectedValueOnce(fault);
    await expect(run(async () => PNG).promise).rejects.toMatchObject({
      code: 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE', status: 503, details: { stage: 'store' },
    });
  });

  it('refuses bytes that would land anywhere but object storage', async () => {
    putBytesMock.mockResolvedValueOnce({ backend: 'db', storageKey: null, data: PNG });
    await expect(run(async () => PNG).promise).rejects.toMatchObject({ code: 'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED', status: 409 });
  });

  it('puts nothing when the reservation was claimed by another run meanwhile (re-checked right before the put)', async () => {
    const { promise, stillPending } = run(async () => PNG, PNG.length, false);
    expect(await promise).toEqual({ kind: 'gone' });
    expect(stillPending).toHaveBeenCalledTimes(1);
    expect(putBytesMock).not.toHaveBeenCalled();
  });

  it('does not re-check a file it skips anyway', async () => {
    const { promise, stillPending } = run(async () => MZ);
    expect(await promise).toEqual({ kind: 'skipped', reason: 'blocked_type' });
    expect(stillPending).not.toHaveBeenCalled();
  });

  it('the fetch error says whether it is permanent', () => {
    expect(new ImportAttachmentFetchError('not_found').permanent).toBe(true);
    expect(new ImportAttachmentFetchError('too_large').permanent).toBe(true);
    expect(new ImportAttachmentFetchError('transient').permanent).toBe(false);
  });
});
