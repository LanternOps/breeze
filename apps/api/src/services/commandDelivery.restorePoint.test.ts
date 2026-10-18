import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-app-encryption-key-for-vitest';

const releaseClaimedCommandDeliveryMock = vi.fn(async () => undefined);
const expireRefusedClaimedCommandDeliveryMock = vi.fn(async () => undefined);
vi.mock('./commandDispatch', () => ({
  releaseClaimedCommandDelivery: (...args: unknown[]) =>
    releaseClaimedCommandDeliveryMock(...(args as [])),
  expireRefusedClaimedCommandDelivery: (...args: unknown[]) =>
    expireRefusedClaimedCommandDeliveryMock(...(args as [])),
}));

// #5128: the SHIPPED software_install refresher calls into S3. Mocked at the
// module boundary so the real refresher body (the s3Key gate, the TTL, the
// isS3Configured() check) is exercised rather than replaced by a fake.
const { getPresignedUrlMock, isS3ConfiguredMock } = vi.hoisted(() => ({
  getPresignedUrlMock: vi.fn(),
  isS3ConfiguredMock: vi.fn(() => true),
}));
vi.mock('./s3Storage', () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...(args as [])),
  isS3Configured: () => isS3ConfiguredMock(),
}));

const captureExceptionMock = vi.fn();
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

// #3409 PR4c-2 — the claim gate. Mocked here (it has its own DB-level suite in
// scriptSecretDelivery.test.ts); these tests assert the WIRING: it runs before
// any decryption, and only what it returns is decrypted and released.
const failClaimedSecretCommandsMock = vi.fn(async (claimed: unknown[]) => claimed);
vi.mock('./scriptSecretDelivery', () => ({
  failClaimedSecretCommandsForUnsupportedAgent: (...args: unknown[]) =>
    failClaimedSecretCommandsMock(...(args as [any])),
}));

const { refreshRestorePointMock } = vi.hoisted(() => ({ refreshRestorePointMock: vi.fn() }));
vi.mock('./restorePointRequest', () => ({
  // Real-shaped predicate (the unit under test is the wiring, not staleness).
  isStaleRestorePointPayload: (payload: any, now: Date) =>
    !!payload?.restorePoint && payload.restorePoint.v === 1 && Date.parse(payload.restorePoint.validUntil) <= now.getTime(),
  refreshRestorePointForDelivery: (...args: unknown[]) => refreshRestorePointMock(...(args as [])),
}));

import {
  DELIVERY_PREPARATION_FAILED_MESSAGE,
  prepareClaimedCommandsForDelivery,
  refreshClaimedPayloadForPush,
} from './commandDelivery';

const DEVICE = '99999999-9999-4999-8999-999999999999';
const claimedAt = new Date('2026-07-13T00:00:00Z');

const staleBlock = {
  v: 1, requestId: 'old', enabled: true, label: 'Breeze: run script X',
  resolvedAt: '2020-01-01T00:00:00.000Z', policyRevision: '', validUntil: '2020-01-02T00:00:00.000Z',
};
const freshBlock = { ...staleBlock, requestId: 'new', validUntil: '2999-01-01T00:00:00.000Z' };

describe('restore-point re-stamp on the delivery claim path (#4756)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failClaimedSecretCommandsMock.mockImplementation(async (claimed: unknown[]) => claimed);
    refreshRestorePointMock.mockImplementation(async (payload: Record<string, unknown>) => ({
      ...payload,
      restorePoint: freshBlock,
    }));
  });

  it('batch: re-stamps a stale block and delivers the refreshed payload', async () => {
    const delivered = await prepareClaimedCommandsForDelivery([
      { id: 'cmd-s', type: 'script', deviceId: DEVICE, payload: { scriptId: 's', restorePoint: staleBlock }, executedAt: claimedAt },
    ]);
    expect(refreshRestorePointMock).toHaveBeenCalledTimes(1);
    expect(refreshRestorePointMock.mock.calls[0]![1]).toMatchObject({
      commandId: 'cmd-s', deviceId: DEVICE, type: 'script', claimedAt,
    });
    expect((delivered[0]!.payload as any).restorePoint).toEqual(freshBlock);
  });

  it('batch: a fresh block or no block is delivered untouched without the re-stamp step', async () => {
    const delivered = await prepareClaimedCommandsForDelivery([
      { id: 'cmd-f', type: 'script', deviceId: DEVICE, payload: { scriptId: 's', restorePoint: freshBlock }, executedAt: claimedAt },
      { id: 'cmd-n', type: 'install_patches', deviceId: DEVICE, payload: { patchIds: ['p'] }, executedAt: claimedAt },
    ]);
    expect(refreshRestorePointMock).not.toHaveBeenCalled();
    expect((delivered[0]!.payload as any).restorePoint).toEqual(freshBlock);
    expect(delivered[1]!.payload).toEqual({ patchIds: ['p'] });
  });

  it('batch: a re-stamp failure releases the row instead of delivering the stale snapshot', async () => {
    refreshRestorePointMock.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const delivered = await prepareClaimedCommandsForDelivery([
      { id: 'cmd-s', type: 'script', deviceId: DEVICE, payload: { scriptId: 's', restorePoint: staleBlock }, executedAt: claimedAt },
    ]);
    expect(delivered).toHaveLength(0);
    expect(releaseClaimedCommandDeliveryMock).toHaveBeenCalledWith('cmd-s', claimedAt, DELIVERY_PREPARATION_FAILED_MESSAGE);
  });

  it('push: composes with the per-type refresher (software_install mints the URL, then re-stamps)', async () => {
    getPresignedUrlMock.mockResolvedValueOnce('https://signed.example/minted');
    const out = await refreshClaimedPayloadForPush(
      'software_install',
      { deploymentId: 'd', s3Key: 'k', restorePoint: staleBlock },
      { commandId: 'cmd-sw', deviceId: DEVICE, type: 'software_install', claimedAt },
    );
    expect(out.ok).toBe(true);
    // the re-stamp step saw the minted URL (it runs after the type refresher)
    expect((refreshRestorePointMock.mock.calls[0]![0] as any).downloadUrl).toBe('https://signed.example/minted');
    if (out.ok) {
      expect(out.payload.restorePoint).toEqual(freshBlock);
      expect(out.payload.downloadUrl).toBe('https://signed.example/minted');
    }
  });

  it('push: a payload without a stale block skips the re-stamp step and keeps its identity', async () => {
    const payload = { scriptId: 's' };
    const out = await refreshClaimedPayloadForPush('script', payload, {
      commandId: 'cmd-p', deviceId: DEVICE, type: 'script', claimedAt,
    });
    expect(out).toEqual({ ok: true, payload });
    expect(out.ok && out.payload).toBe(payload);
    expect(refreshRestorePointMock).not.toHaveBeenCalled();
  });
});
