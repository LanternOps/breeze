import { describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));

const enqueuePublishedMock = vi.hoisted(() => vi.fn(async (_ids: string[]) => 1));
vi.mock('./backupSnapshotAttestationWorker', () => ({
  enqueueVerificationForPublishedSnapshots: enqueuePublishedMock,
}));

import { __testOnly } from './backupWriteSessionJanitor';
import { RESERVATION_CLEANUP_EVERY_MS } from '../services/backupSnapshotIdReservations';

describe('backupWriteSessionJanitor default deps', () => {
  it('runs at the period attestation verification assumes when it predicts publication', () => {
    expect(__testOnly.RUN_EVERY_MS).toBe(RESERVATION_CLEANUP_EVERY_MS);
  });

  it('hands the snapshots it publishes to attestation verification', async () => {
    const { onPublished } = __testOnly.defaultDeps;
    expect(onPublished).toBeTypeOf('function');
    await onPublished!(['snap-db-1', 'snap-db-2']);
    expect(enqueuePublishedMock).toHaveBeenCalledWith(['snap-db-1', 'snap-db-2']);
  });
});
