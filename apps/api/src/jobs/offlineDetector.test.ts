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

vi.mock('../db', () => ({
  db: {},
}));

vi.mock('../db/schema', () => ({
  devices: {},
  alertRules: {},
  alertTemplates: {},
  alerts: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../services/alertService', () => ({
  createAlert: vi.fn(),
}));

vi.mock('../services/alertConditions', () => ({
  interpolateTemplate: vi.fn(),
}));

import { shutdownOfflineDetector, triggerOfflineDetection } from './offlineDetector';

describe('triggerOfflineDetection', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownOfflineDetector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for manual offline detection requests', async () => {
    await triggerOfflineDetection(10);

    expect(addMock).toHaveBeenCalledWith(
      'detect-offline',
      expect.objectContaining({ thresholdMinutes: 10 }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^offline-detect:10:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active offline detection job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await triggerOfflineDetection();

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
