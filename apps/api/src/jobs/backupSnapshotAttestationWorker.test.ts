import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queueMock = vi.hoisted(() => ({
  getJob: vi.fn(),
  add: vi.fn(),
}));
vi.mock('bullmq', () => ({ Queue: vi.fn(function Queue() { return queueMock; }), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const pendingRows = vi.hoisted(() => ({ rows: [] as Array<{ snapshotDbId: string }> }));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => pendingRows.rows }) }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock('../services/backupAttestationVerify', () => ({ verifySnapshotAttestation: verifyMock, MAX_VERIFY_ATTEMPTS: 20 }));

import {
  __testOnly,
  attestationJobId,
  enqueueVerificationForPublishedSnapshots,
  publishedAttestationJobId,
  sweepDueBy,
} from './backupSnapshotAttestationWorker';

const job = (snapshotDbId: string) => ({ data: { type: 'verify' as const, snapshotDbId } }) as never;
const SWEEP_EVERY_MS = 15 * 60_000;

describe('backupSnapshotAttestationWorker', () => {
  beforeEach(() => {
    verifyMock.mockReset();
    queueMock.getJob.mockReset();
    queueMock.add.mockReset();
    queueMock.add.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({ id: opts.jobId }));
    pendingRows.rows = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a snapshot-scoped job id without a colon', () => {
    expect(attestationJobId('abc')).toBe('attest-abc');
    expect(publishedAttestationJobId('abc')).toBe('attest-published-abc');
  });

  it('completes a deferred verification: the row stays pending and the sweep retries it when due', async () => {
    verifyMock.mockResolvedValue({ outcome: 'retry', reason: 'fetch_failed:manifest' });
    await expect(__testOnly.processAttestationJob(job('s1'))).resolves.toEqual({ status: 'retry' });
  });

  it.each(['verified', 'mismatch', 'skipped'] as const)('completes on %s', async (outcome) => {
    verifyMock.mockResolvedValue({ outcome });
    await expect(__testOnly.processAttestationJob(job('s1'))).resolves.toEqual({ status: outcome });
  });

  it('sweeps a retry that was scheduled a few ms after the previous tick at the next tick', () => {
    // The sweep fires on the tick; the attempt it triggers defers a few ms
    // later, so a one-period backoff lands just after the next tick.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T01:15:00.000Z'));
    const tick = Date.now();
    vi.advanceTimersByTime(4);
    const retryAt = Date.now() + SWEEP_EVERY_MS; // 01:30:00.004

    vi.setSystemTime(new Date(tick + SWEEP_EVERY_MS)); // next tick, 01:30:00.000
    expect(sweepDueBy(new Date()).getTime()).toBeGreaterThanOrEqual(retryAt);
    // Still a lookahead, not the next period: a row due at the tick after is not swept.
    expect(sweepDueBy(new Date()).getTime()).toBeLessThan(tick + 2 * SWEEP_EVERY_MS);
  });

  it('queues the publication kick under its own id, so a verification still running is not reused', async () => {
    // The sweep's verification read the snapshot while it was still sealing
    // and is finishing; the reservation has just been published.
    pendingRows.rows = [{ snapshotDbId: 's1' }];
    queueMock.getJob.mockImplementation(async (id: string) =>
      id === attestationJobId('s1') ? { id, getState: async () => 'active', remove: vi.fn() } : null,
    );
    await expect(enqueueVerificationForPublishedSnapshots(['s1'])).resolves.toBe(1);
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    expect(queueMock.add).toHaveBeenCalledWith(
      'verify',
      { type: 'verify', snapshotDbId: 's1' },
      expect.objectContaining({ jobId: publishedAttestationJobId('s1'), attempts: 1 }),
    );
  });

  it('kicks nothing when no published snapshot has a pending server-fetched attestation', async () => {
    pendingRows.rows = [];
    await expect(enqueueVerificationForPublishedSnapshots(['s1', 's2'])).resolves.toBe(0);
    expect(queueMock.add).not.toHaveBeenCalled();
    await expect(enqueueVerificationForPublishedSnapshots([])).resolves.toBe(0);
  });

  it('keeps kicking the other snapshots when one enqueue fails', async () => {
    pendingRows.rows = [{ snapshotDbId: 's1' }, { snapshotDbId: 's2' }];
    queueMock.getJob.mockResolvedValue(null);
    queueMock.add.mockRejectedValueOnce(new Error('redis down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(enqueueVerificationForPublishedSnapshots(['s1', 's2'])).resolves.toBe(1);
    expect(queueMock.add).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
