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
});
