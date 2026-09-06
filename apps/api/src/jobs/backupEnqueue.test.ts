import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, closeMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    close = closeMock;
  }
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

import {
  closeBackupQueue,
  enqueueBackupDispatch,
  enqueueBackupResults,
} from './backupEnqueue';

describe('backup enqueue helpers', () => {
  beforeEach(async () => {
    addMock.mockReset();
    closeMock.mockReset();
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await closeBackupQueue();
  });

  it('uses a stable BullMQ job id for backup dispatch', async () => {
    await enqueueBackupDispatch('job-123', 'cfg-1', 'org-1', 'dev-1');

    expect(addMock).toHaveBeenCalledWith(
      'dispatch-backup',
      expect.objectContaining({ jobId: 'job-123' }),
      expect.objectContaining({ jobId: 'backup-dispatch-job-123' }),
    );
  });

  it('uses a stable BullMQ job id for backup result processing', async () => {
    await enqueueBackupResults('job-123', 'org-1', 'dev-1', { status: 'completed' });

    expect(addMock).toHaveBeenCalledWith(
      'process-results',
      expect.objectContaining({ jobId: 'job-123' }),
      expect.objectContaining({ jobId: 'backup-result-job-123' }),
    );
  });

  it('rejects malformed backup result payloads before enqueueing', async () => {
    await expect(
      enqueueBackupResults('job-123', 'org-1', 'dev-1', { status: '' }),
    ).rejects.toThrow();

    expect(addMock).not.toHaveBeenCalled();
  });

  // #4137: dispatch-backup is NOT idempotent — Phase 3 of processDispatchBackup
  // INSERTs a fresh `backup_jobs` child row per extra target on every run, so a
  // BullMQ retry after a Phase-4/5 failure leaves the previous attempt's
  // children orphaned at status='running' forever. It must be a one-shot.
  it('enqueues dispatch-backup with attempts:1 and no backoff (non-idempotent one-shot, #4137)', async () => {
    await enqueueBackupDispatch('job-123', 'cfg-1', 'org-1', 'dev-1');

    const opts = addMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.attempts).toBe(1);
    expect(opts.backoff).toBeUndefined();
  });

  // process-results IS safely retryable (it re-applies the same agent payload
  // to the same job row) and genuinely benefits from retry on a transient DB
  // blip — it must keep the retrying options the dispatch path gives up.
  it('keeps attempts:3 + exponential backoff for process-results', async () => {
    await enqueueBackupResults('job-123', 'org-1', 'dev-1', { status: 'completed' });

    const opts = addMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 1_000 });
  });
});
