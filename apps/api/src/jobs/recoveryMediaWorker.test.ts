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

vi.mock('../services/recoveryMediaService', () => ({
  authorizeAndClaimRecoveryMediaArtifact: (...args: unknown[]) => shared.authorizeAndClaimMock(...args),
  buildRecoveryMediaArtifact: (...args: unknown[]) => shared.buildMock(...args),
  recordRecoveryMediaBuildFailure: (...args: unknown[]) => shared.recordFailureMock(...args),
}));

import {
  enqueueRecoveryMediaBuild,
  processRecoveryMediaBuildJob,
  shutdownRecoveryMediaWorker,
} from './recoveryMediaWorker';

class KnownAuthorizationDenial extends Error {
  readonly retriable = false;
  readonly code = 'principal_disabled';
}

describe('recovery media queueing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shared.getJobMock.mockResolvedValue(null);
    shared.addMock.mockResolvedValue({ id: 'queue-job-1' });
    shared.authorizeAndClaimMock.mockResolvedValue(true);
    shared.buildMock.mockResolvedValue(undefined);
    shared.recordFailureMock.mockResolvedValue(undefined);
    await shutdownRecoveryMediaWorker();
  });

  it('uses a stable BullMQ job id for recovery media builds', async () => {
    await enqueueRecoveryMediaBuild('artifact-1');

    expect(shared.addMock).toHaveBeenCalledWith(
      'build-media',
      expect.objectContaining({ artifactId: 'artifact-1' }),
      expect.objectContaining({ jobId: 'recovery-media-artifact-1' }),
    );
  });

  it('rejects malformed recovery media jobs before enqueueing', async () => {
    await expect(enqueueRecoveryMediaBuild('')).rejects.toThrow();
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it.each([
    'user_session',
    'client_user',
    'api_key',
    'oauth_grant',
    'ai_agent',
  ])('reloads and claims durable %s authority before invoking the builder', async (principalKind) => {
    shared.authorizeAndClaimMock.mockResolvedValueOnce({ claimed: true, principalKind });

    await processRecoveryMediaBuildJob({
      id: 'job-1',
      name: 'build-media',
      data: { type: 'build-media', artifactId: 'artifact-1' },
    } as any);

    expect(shared.authorizeAndClaimMock).toHaveBeenCalledWith('artifact-1');
    expect(shared.authorizeAndClaimMock.mock.invocationCallOrder[0]).toBeLessThan(
      shared.buildMock.mock.invocationCallOrder[0]!,
    );
    expect(shared.buildMock).toHaveBeenCalledWith('artifact-1');
  });

  it('turns a durable known denial into an unrecoverable job with zero builder effects', async () => {
    shared.authorizeAndClaimMock.mockRejectedValueOnce(new KnownAuthorizationDenial());

    await expect(processRecoveryMediaBuildJob({
      id: 'job-1',
      name: 'build-media',
      data: { type: 'build-media', artifactId: 'artifact-1' },
    } as any)).rejects.toMatchObject({ name: 'UnrecoverableError' });

    expect(shared.buildMock).not.toHaveBeenCalled();
    expect(shared.addMock).not.toHaveBeenCalled();
  });

  it('preserves transient authorization failures for BullMQ retry with zero builder effects', async () => {
    const transient = Object.assign(new Error('authorization dependency unavailable'), { retriable: true });
    shared.authorizeAndClaimMock.mockRejectedValueOnce(transient);

    await expect(processRecoveryMediaBuildJob({
      id: 'job-1',
      name: 'build-media',
      data: { type: 'build-media', artifactId: 'artifact-1' },
    } as any)).rejects.toBe(transient);

    expect(shared.buildMock).not.toHaveBeenCalled();
  });

  it('retries a stale authorization-subject claim conflict without invoking the builder', async () => {
    shared.authorizeAndClaimMock.mockResolvedValueOnce(false);

    await expect(processRecoveryMediaBuildJob({
      id: 'job-1',
      name: 'build-media',
      data: { type: 'build-media', artifactId: 'artifact-1' },
    } as any)).rejects.toThrow(/claim changed/);

    expect(shared.buildMock).not.toHaveBeenCalled();
  });

  it('durably records a builder failure so the delayed BullMQ attempt can reauthorize', async () => {
    const failure = new Error('storage unavailable');
    shared.buildMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const job = {
      id: 'job-1',
      name: 'build-media',
      data: { type: 'build-media', artifactId: 'artifact-1' },
    } as any;

    await expect(processRecoveryMediaBuildJob(job)).rejects.toBe(failure);
    await processRecoveryMediaBuildJob(job);

    expect(shared.recordFailureMock).toHaveBeenCalledWith('artifact-1', failure);
    expect(shared.authorizeAndClaimMock).toHaveBeenCalledTimes(2);
  });
});
