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

vi.mock('../services/recoveryBootMediaService', () => ({
  buildRecoveryBootMediaArtifact: vi.fn(),
}));

import {
  enqueueRecoveryBootMediaBuild,
  shutdownRecoveryBootMediaWorker,
} from './recoveryBootMediaWorker';

describe('recovery boot media queueing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownRecoveryBootMediaWorker();
  });

  it('uses a stable BullMQ job id for recovery boot media builds', async () => {
    await enqueueRecoveryBootMediaBuild('artifact-1');

    expect(shared.addMock).toHaveBeenCalledWith(
      'build-boot-media',
      expect.objectContaining({ artifactId: 'artifact-1' }),
      expect.objectContaining({ jobId: 'recovery-boot-media:artifact-1' }),
    );
  });

  it('rejects malformed recovery boot media jobs before enqueueing', async () => {
    await expect(enqueueRecoveryBootMediaBuild('')).rejects.toThrow();
    expect(shared.addMock).not.toHaveBeenCalled();
  });
});
