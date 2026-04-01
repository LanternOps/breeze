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
}));

import {
  closeBackupQueue,
  enqueueBackupDispatch,
  enqueueBackupResults,
  enqueueRestoreDispatch,
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

  it('uses a stable BullMQ job id for restore dispatch', async () => {
    await enqueueRestoreDispatch('restore-123', 'snap-1', 'dev-1', 'org-1');

    expect(addMock).toHaveBeenCalledWith(
      'dispatch-restore',
      expect.objectContaining({ restoreJobId: 'restore-123' }),
      expect.objectContaining({ jobId: 'backup-restore-restore-123' }),
    );
  });

  it('rejects malformed backup result payloads before enqueueing', async () => {
    await expect(
      enqueueBackupResults('job-123', 'org-1', 'dev-1', { status: '' }),
    ).rejects.toThrow();

    expect(addMock).not.toHaveBeenCalled();
  });
});
