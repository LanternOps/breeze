import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { writeOAuthRevocationMarkerDurably } from '../oauth/revocationRetry';
import {
  drainOAuthRevocationRetries,
  initializeOAuthRevocationRetryWorker,
  shutdownOAuthRevocationRetryWorker,
} from './oauthRevocationRetryWorker';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../oauth/revocationRetry', () => ({
  writeOAuthRevocationMarkerDurably: vi.fn(),
}));

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  markerType: 'grant' as const,
  markerId: 'secret-marker',
  expiresAt: new Date(Date.now() + 60_000),
  attempts: 1,
};

function mockClaimRows(rows: unknown[]) {
  const forUpdate = vi.fn(async () => rows);
  const limit = vi.fn(() => ({ for: forUpdate }));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  vi.mocked(db.select).mockReturnValue({ from } as unknown as ReturnType<typeof db.select>);
  return { forUpdate, limit };
}

function mockUpdate() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  vi.mocked(db.update).mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where };
}

describe('OAuth revocation retry worker', () => {
  beforeEach(async () => {
    await shutdownOAuthRevocationRetryWorker();
    vi.clearAllMocks();
    vi.mocked(runOutsideDbContext).mockImplementation((fn: () => unknown) => fn() as never);
    vi.mocked(withSystemDbAccessContext).mockImplementation(
      (async (fn: () => Promise<unknown>) => fn()) as never,
    );
  });

  it('claims a bounded batch with FOR UPDATE SKIP LOCKED and completes successful retries', async () => {
    const claim = mockClaimRows([ROW]);
    const update = mockUpdate();
    vi.mocked(writeOAuthRevocationMarkerDurably).mockResolvedValue({ status: 'written' });

    await expect(drainOAuthRevocationRetries(25)).resolves.toBe(1);

    expect(claim.limit).toHaveBeenCalledWith(25);
    expect(claim.forUpdate).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(writeOAuthRevocationMarkerDurably).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        userId: ROW.userId,
        markerType: ROW.markerType,
        markerId: ROW.markerId,
        expiresAt: ROW.expiresAt,
      }),
    );
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      completedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    }));
  });

  it('completes expired work without making a Redis marker call', async () => {
    mockClaimRows([{ ...ROW, expiresAt: new Date(Date.now() - 1) }]);
    mockUpdate();

    await expect(drainOAuthRevocationRetries(10)).resolves.toBe(1);

    expect(writeOAuthRevocationMarkerDurably).not.toHaveBeenCalled();
  });

  it('leaves failed work incomplete after the durable helper schedules backoff', async () => {
    mockClaimRows([ROW]);
    const update = mockUpdate();
    vi.mocked(writeOAuthRevocationMarkerDurably).mockResolvedValue({
      status: 'retry_queued',
      errorCode: 'redis_write_failed',
    });

    await expect(drainOAuthRevocationRetries(10)).resolves.toBe(0);

    expect(update.set).not.toHaveBeenCalledWith(expect.objectContaining({
      completedAt: expect.any(Date),
    }));
  });

  it('registers and gracefully stops a bounded periodic drain', async () => {
    vi.useFakeTimers();
    mockClaimRows([]);
    mockUpdate();

    initializeOAuthRevocationRetryWorker();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(db.select).toHaveBeenCalled();

    await shutdownOAuthRevocationRetryWorker();
    const callsAtShutdown = vi.mocked(db.select).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.select).toHaveBeenCalledTimes(callsAtShutdown);
    vi.useRealTimers();
  });
});
