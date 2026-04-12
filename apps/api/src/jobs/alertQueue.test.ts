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
  db: {},

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  deviceMetrics: {},
  organizations: {},
  alerts: {},
}));

vi.mock('../services/alertService', () => ({
  evaluateDeviceAlerts: vi.fn(),
  checkAllAutoResolve: vi.fn(),
  evaluateDeviceAlertsFromPolicy: vi.fn(),
  checkAutoResolveFromConfigPolicy: vi.fn(),
}));

import {
  shutdownAlertWorkers,
  triggerDeviceEvaluation,
  triggerFullEvaluation,
} from './alertWorker';

describe('alert queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownAlertWorkers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for device evaluation requests', async () => {
    await triggerDeviceEvaluation('device-1', 'org-1');

    expect(addMock).toHaveBeenCalledWith(
      'evaluate-device',
      expect.objectContaining({ deviceId: 'device-1', orgId: 'org-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^alert-evaluate-device:device-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active full evaluation job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await triggerFullEvaluation();

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
