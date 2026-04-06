import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = shared.getJobMock;
    add = shared.addMock;
    close = shared.closeMock;
  },
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock('../services/drExecutionService', () => ({
  reconcileDrExecution: vi.fn(),
}));

import {
  enqueueDrExecutionReconcile,
  shutdownDrExecutionWorker,
} from './drExecutionWorker';

describe('dr execution queueing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownDrExecutionWorker();
  });

  it('uses a stable BullMQ job id for DR execution reconcile', async () => {
    await enqueueDrExecutionReconcile('exec-1', 1234);

    expect(shared.addMock).toHaveBeenCalledWith(
      'reconcile-execution',
      expect.objectContaining({
        type: 'reconcile-execution',
        executionId: 'exec-1',
        meta: expect.objectContaining({ actorType: 'system' }),
      }),
      expect.objectContaining({
        jobId: 'dr-execution:exec-1',
        delay: 1234,
        attempts: 3,
      }),
    );
  });

  it('reuses an active DR execution reconcile job for the same execution id', async () => {
    shared.getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await enqueueDrExecutionReconcile('exec-1');

    expect(shared.addMock).not.toHaveBeenCalled();
    expect(jobId).toBe('existing-job');
  });

  it('rejects malformed DR execution jobs before enqueueing', async () => {
    await expect(enqueueDrExecutionReconcile('')).rejects.toThrow();
    expect(shared.addMock).not.toHaveBeenCalled();
  });
});
