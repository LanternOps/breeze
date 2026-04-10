import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  Worker: class {
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

vi.mock('../db/schema', () => ({
  devices: {},
}));

vi.mock('../services/reliabilityScoring', () => ({
  computeAndPersistDeviceReliability: vi.fn(),
  computeAndPersistOrgReliability: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import {
  enqueueDeviceReliabilityComputation,
  shutdownReliabilityWorker,
} from './reliabilityWorker';

describe('enqueueDeviceReliabilityComputation', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownReliabilityWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for device reliability recompute requests', async () => {
    await enqueueDeviceReliabilityComputation('device-1');

    expect(addMock).toHaveBeenCalledWith(
      'compute-device',
      expect.objectContaining({ deviceId: 'device-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^reliability-device:device-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active device recompute job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueDeviceReliabilityComputation('device-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
