import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock('../services/backupAttestationVerify', () => ({ verifySnapshotAttestation: verifyMock }));

import { __testOnly, attestationJobId } from './backupSnapshotAttestationWorker';

const job = (snapshotDbId: string) => ({ data: { type: 'verify' as const, snapshotDbId } }) as never;

describe('backupSnapshotAttestationWorker', () => {
  beforeEach(() => verifyMock.mockReset());

  it('uses a snapshot-scoped job id without a colon', () => {
    expect(attestationJobId('abc')).toBe('attest-abc');
  });

  it('throws on a deferred verification so BullMQ retries it (the row stays pending)', async () => {
    verifyMock.mockResolvedValue({ outcome: 'retry', reason: 'fetch_failed:manifest' });
    await expect(__testOnly.processAttestationJob(job('s1'))).rejects.toThrow('fetch_failed:manifest');
  });

  it.each(['verified', 'mismatch', 'skipped'] as const)('completes on %s', async (outcome) => {
    verifyMock.mockResolvedValue({ outcome });
    await expect(__testOnly.processAttestationJob(job('s1'))).resolves.toEqual({ status: outcome });
  });
});
