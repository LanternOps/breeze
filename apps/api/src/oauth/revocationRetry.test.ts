import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeGrant, revokeJti } from './revocationCache';
import {
  writeOAuthRevocationMarkerDurably,
  type DbTransaction,
} from './revocationRetry';

vi.mock('./revocationCache', () => ({
  revokeGrant: vi.fn(async () => undefined),
  revokeJti: vi.fn(async () => undefined),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

function fakeTransaction(returningRows: unknown[] = [{ userId: USER_ID }]) {
  const returning = vi.fn(async () => returningRows);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return {
    tx: { insert } as unknown as DbTransaction,
    insert,
    values,
    onConflictDoUpdate,
    returning,
  };
}

describe('writeOAuthRevocationMarkerDurably', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the requested marker with its exact remaining lifetime and creates no retry row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    const fake = fakeTransaction();

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'grant-secret',
      expiresAt: new Date('2026-08-06T00:02:00.000Z'),
    })).resolves.toEqual({ status: 'written' });

    expect(revokeGrant).toHaveBeenCalledWith('grant-secret', 120);
    expect(revokeJti).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('queues one exact-user retry intent when Redis is unavailable', async () => {
    vi.mocked(revokeJti).mockRejectedValueOnce(new Error('OAuth revocation cache unavailable'));
    const fake = fakeTransaction();

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'jti',
      markerId: 'jti-secret',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toEqual({ status: 'retry_queued', errorCode: 'redis_unavailable' });

    expect(fake.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      markerType: 'jti',
      markerId: 'jti-secret',
      attempts: 1,
      lastErrorCode: 'redis_unavailable',
    }));
  });

  it('uses an ownership-preserving incomplete-marker upsert for repeated failures', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction();

    await writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'grant-secret',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(fake.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.any(Array),
      targetWhere: expect.anything(),
      set: expect.objectContaining({
        attempts: expect.anything(),
        nextAttemptAt: expect.anything(),
        lastErrorCode: 'redis_write_failed',
      }),
      setWhere: expect.anything(),
    }));
  });

  it('fails closed when an incomplete marker belongs to another user', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction([]);

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: OTHER_USER_ID,
      markerType: 'grant',
      markerId: 'already-owned-marker',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow(/owner/i);
  });

  it('fails closed when the durable enqueue itself fails', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction();
    fake.returning.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'grant-secret',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow('database unavailable');
  });

  it('does not log marker identifiers on failure', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'never-log-this-marker',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const serializedLogs = JSON.stringify([
      ...consoleError.mock.calls,
      ...consoleWarn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain('never-log-this-marker');
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});
