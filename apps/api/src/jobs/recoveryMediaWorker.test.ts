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
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/recoveryMediaService', () => ({
  buildRecoveryMediaArtifact: vi.fn(),
}));

import {
  enqueueRecoveryMediaBuild,
  shutdownRecoveryMediaWorker,
} from './recoveryMediaWorker';

describe('recovery media queueing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownRecoveryMediaWorker();
  });

  it('uses a stable BullMQ job id for recovery media builds', async () => {
    await enqueueRecoveryMediaBuild('artifact-1');

    expect(shared.addMock).toHaveBeenCalledWith(
      'build-media',
      expect.objectContaining({ artifactId: 'artifact-1' }),
      expect.objectContaining({ jobId: 'recovery-media:artifact-1' }),
    );
  });

  it('rejects malformed recovery media jobs before enqueueing', async () => {
    await expect(enqueueRecoveryMediaBuild('')).rejects.toThrow();
    expect(shared.addMock).not.toHaveBeenCalled();
  });
});
