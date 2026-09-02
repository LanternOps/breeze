import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  authorizeAndClaimMock: vi.fn(),
  buildMock: vi.fn(),
  recordFailureMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = shared.getJobMock;
    add = shared.addMock;
    close = shared.closeMock;
  },
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error { name = 'UnrecoverableError'; },
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../services/recoveryBootMediaService', () => ({
  authorizeAndClaimRecoveryBootMediaArtifact: (...args: unknown[]) => shared.authorizeAndClaimMock(...args),
  buildRecoveryBootMediaArtifact: (...args: unknown[]) => shared.buildMock(...args),
  recordRecoveryBootMediaBuildFailure: (...args: unknown[]) => shared.recordFailureMock(...args),
}));

import {
  enqueueRecoveryBootMediaBuild,
  processRecoveryBootMediaBuildJob,
  shutdownRecoveryBootMediaWorker,
} from './recoveryBootMediaWorker';

class KnownAuthorizationDenial extends Error {
  readonly retriable = false;
  readonly code = 'site_access_denied';
}

describe('recovery boot media queueing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    shared.authorizeAndClaimMock.mockResolvedValue(true);
    shared.buildMock.mockResolvedValue(undefined);
    shared.recordFailureMock.mockResolvedValue(undefined);
    await shutdownRecoveryBootMediaWorker();
  });

  it('uses a stable BullMQ job id for recovery boot media builds', async () => {
    await enqueueRecoveryBootMediaBuild('artifact-1');

    expect(shared.addMock).toHaveBeenCalledWith(
      'build-boot-media',
      expect.objectContaining({ artifactId: 'artifact-1' }),
      expect.objectContaining({ jobId: 'recovery-boot-media-artifact-1' }),
    );
  });

  it('rejects malformed recovery boot media jobs before enqueueing', async () => {
    await expect(enqueueRecoveryBootMediaBuild('')).rejects.toThrow();
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('reauthorizes delayed boot-media retries before each builder attempt', async () => {
    const job = {
      id: 'job-1',
      name: 'build-boot-media',
      data: { type: 'build-boot-media', artifactId: 'artifact-1' },
    } as any;

    await processRecoveryBootMediaBuildJob(job);
    await processRecoveryBootMediaBuildJob(job);

    expect(shared.authorizeAndClaimMock).toHaveBeenCalledTimes(2);
    expect(shared.buildMock).toHaveBeenCalledTimes(2);
  });

  it('turns source-site denial into an unrecoverable job with zero builder effects', async () => {
    shared.authorizeAndClaimMock.mockRejectedValueOnce(new KnownAuthorizationDenial());

    await expect(processRecoveryBootMediaBuildJob({
      id: 'job-1',
      name: 'build-boot-media',
      data: { type: 'build-boot-media', artifactId: 'artifact-1' },
    } as any)).rejects.toMatchObject({ name: 'UnrecoverableError' });

    expect(shared.buildMock).not.toHaveBeenCalled();
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('preserves transient authorization failures for BullMQ retry', async () => {
    const transient = Object.assign(new Error('database unavailable'), { retriable: true });
    shared.authorizeAndClaimMock.mockRejectedValueOnce(transient);

    await expect(processRecoveryBootMediaBuildJob({
      id: 'job-1',
      name: 'build-boot-media',
      data: { type: 'build-boot-media', artifactId: 'artifact-1' },
    } as any)).rejects.toBe(transient);

    expect(shared.buildMock).not.toHaveBeenCalled();
  });

  it('durably records a boot-media builder failure before BullMQ retries', async () => {
    const failure = new Error('signing service unavailable');
    shared.buildMock.mockRejectedValueOnce(failure);

    await expect(processRecoveryBootMediaBuildJob({
      id: 'job-1',
      name: 'build-boot-media',
      data: { type: 'build-boot-media', artifactId: 'artifact-1' },
    } as any)).rejects.toBe(failure);

    expect(shared.recordFailureMock).toHaveBeenCalledWith('artifact-1', failure);
  });
});
