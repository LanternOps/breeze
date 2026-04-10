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
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  cisBaselines: {},
  cisRemediationActions: {},
  devices: {},
}));

vi.mock('../services/commandQueue', () => ({
  queueCommand: vi.fn(),
}));

vi.mock('../services/cisHardening', () => ({
  normalizeCisSchedule: vi.fn(),
}));

vi.mock('../services/cisCatalog', () => ({
  seedDefaultCisCheckCatalog: vi.fn(),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { scheduleCisScan, shutdownCisJobs } from './cisJobs';

describe('scheduleCisScan', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownCisJobs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for manual CIS scans and normalizes device ids', async () => {
    await scheduleCisScan('baseline-1', { deviceIds: ['device-2', 'device-1', 'device-2'] });

    expect(addMock).toHaveBeenCalledWith(
      'run-baseline-scan',
      expect.objectContaining({ baselineId: 'baseline-1', deviceIds: ['device-1', 'device-2'] }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^cis-manual-scan:baseline-1:device-1,device-2:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active manual CIS scan job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await scheduleCisScan('baseline-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
