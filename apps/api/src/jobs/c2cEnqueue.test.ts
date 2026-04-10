import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

import {
  closeC2cQueue,
  enqueueC2cRestore,
  enqueueC2cSync,
} from './c2cEnqueue';

describe('c2c enqueue helpers', () => {
  beforeEach(async () => {
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await closeC2cQueue();
  });

  it('uses a stable BullMQ job id for C2C sync dispatch', async () => {
    await enqueueC2cSync('job-123', 'cfg-1', 'org-1');

    expect(addMock).toHaveBeenCalledWith(
      'run-sync',
      expect.objectContaining({ jobId: 'job-123', configId: 'cfg-1' }),
      expect.objectContaining({ jobId: 'c2c-sync:job-123' }),
    );
  });

  it('reuses an active C2C sync queue job for the same logical job id', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-sync-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueC2cSync('job-123', 'cfg-1', 'org-1');

    expect(addMock).not.toHaveBeenCalled();
    expect(jobId).toBe('existing-sync-job');
  });

  it('uses a stable BullMQ job id for C2C restore dispatch', async () => {
    await enqueueC2cRestore('restore-123', 'org-1', ['item-1'], null);

    expect(addMock).toHaveBeenCalledWith(
      'process-restore',
      expect.objectContaining({ restoreJobId: 'restore-123', itemIds: ['item-1'] }),
      expect.objectContaining({ jobId: 'c2c-restore:restore-123' }),
    );
  });
});
