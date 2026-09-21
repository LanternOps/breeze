import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queueState } = vi.hoisted(() => ({
  queueState: {
    getJob: vi.fn(async (_id: string) => null as null | { id: string; getState: () => Promise<string>; remove: () => Promise<void> }),
    add: vi.fn(async (_name: string, _data: unknown, opts: { jobId: string }) => ({ id: opts.jobId })),
    close: vi.fn(async () => {}),
  },
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => queueState),
}));

import { createInstrumentedQueue } from '../services/bullmqQueue';
import {
  BACKUP_PROVIDER_SYNC_QUEUE,
  backupProviderSyncJobId,
  enqueueBackupProviderSync,
  getBackupProviderSyncQueue,
  shutdownBackupProviderSyncQueue,
} from './backupProviderSync';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

describe('backup provider sync queue', () => {
  beforeEach(async () => {
    await shutdownBackupProviderSyncQueue();
    vi.clearAllMocks();
    queueState.getJob.mockResolvedValue(null);
  });

  it('uses the contracted queue name, through the instrumented factory', () => {
    // createInstrumentedQueue, not `new Queue`: it is what carries the #1105
    // assertOutsideHeldDbContext tripwire onto every enqueue.
    getBackupProviderSyncQueue();
    expect(createInstrumentedQueue).toHaveBeenCalledWith('backup-provider-sync');
    expect(BACKUP_PROVIDER_SYNC_QUEUE).toBe('backup-provider-sync');
  });

  it('reuses one Queue instance across calls', () => {
    getBackupProviderSyncQueue();
    getBackupProviderSyncQueue();
    expect(createInstrumentedQueue).toHaveBeenCalledTimes(1);
  });

  it('builds the contracted per-connection job id', () => {
    expect(backupProviderSyncJobId(CONNECTION_ID)).toBe(`backup-provider-sync-${CONNECTION_ID}`);
  });

  it('enqueues sync-connection under that job id, with retries', async () => {
    const id = await enqueueBackupProviderSync(CONNECTION_ID);
    expect(id).toBe(`backup-provider-sync-${CONNECTION_ID}`);
    expect(queueState.add).toHaveBeenCalledWith(
      'sync-connection',
      { type: 'sync-connection', connectionId: CONNECTION_ID },
      expect.objectContaining({
        jobId: `backup-provider-sync-${CONNECTION_ID}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
  });

  it('COALESCES with an in-flight job instead of queueing a second one', async () => {
    // "Sync now" while a scheduled sync is already running must not start a
    // second enumeration of the same connection — the sync holds a per-
    // connection advisory lock in W02 and the second would just block a worker.
    queueState.getJob.mockResolvedValue({
      id: `backup-provider-sync-${CONNECTION_ID}`,
      getState: async () => 'active',
      remove: vi.fn(async () => {}),
    });
    const id = await enqueueBackupProviderSync(CONNECTION_ID);
    expect(id).toBe(`backup-provider-sync-${CONNECTION_ID}`);
    expect(queueState.add).not.toHaveBeenCalled();
  });

  it('REPLACES a spent (failed) job record so "Sync now" is never a silent no-op', async () => {
    // BullMQ's jobId dedup keys on "a record with this id exists", and
    // removeOnFail keeps the last failures around — so a bare add() after a
    // failed sync is silently discarded and the operator's retry does nothing.
    const remove = vi.fn(async () => {});
    queueState.getJob.mockResolvedValue({
      id: `backup-provider-sync-${CONNECTION_ID}`,
      getState: async () => 'failed',
      remove,
    });
    await enqueueBackupProviderSync(CONNECTION_ID);
    expect(remove).toHaveBeenCalled();
    expect(queueState.add).toHaveBeenCalled();
  });

  it('rejects a blank connection id rather than queueing an unrunnable job', async () => {
    await expect(enqueueBackupProviderSync('')).rejects.toThrow(/connection id/i);
    expect(queueState.add).not.toHaveBeenCalled();
  });

  it('closes and forgets the queue on shutdown', async () => {
    getBackupProviderSyncQueue();
    await shutdownBackupProviderSyncQueue();
    expect(queueState.close).toHaveBeenCalled();
    getBackupProviderSyncQueue();
    expect(createInstrumentedQueue).toHaveBeenCalledTimes(2);
  });
});
