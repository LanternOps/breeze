import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock, shouldProduceMlOutputMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  shouldProduceMlOutputMock: vi.fn(),
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
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn((state: string) => ['waiting', 'delayed', 'active'].includes(state)),
}));

vi.mock('../services/mlFeatureFlags', () => ({
  shouldProduceMlOutput: shouldProduceMlOutputMock,
}));

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  alerts: {},
  alertCorrelations: {},
}));

import {
  buildAlertCorrelationJobId,
  enqueueAlertCorrelation,
  runAlertCorrelationForDevice,
  shutdownAlertCorrelationWorker,
} from './alertCorrelation';

describe('alert correlation queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockResolvedValue(true);
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-correlation-job' });
    await shutdownAlertCorrelationWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id per org/device debounce slot', async () => {
    const jobId = buildAlertCorrelationJobId('org-1', 'device-1');

    await enqueueAlertCorrelation({ orgId: 'org-1', deviceId: 'device-1' });

    expect(jobId).toMatch(/^alert-correlation-org-1-device-1-[a-z0-9]+$/);
    expect(addMock).toHaveBeenCalledWith(
      'correlate-device-alerts',
      expect.objectContaining({ orgId: 'org-1', deviceId: 'device-1' }),
      expect.objectContaining({ jobId, delay: 5000 }),
    );
  });

  it('reuses an already queued device correlation job in the same slot', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-correlation-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await enqueueAlertCorrelation({ orgId: 'org-1', deviceId: 'device-1' });

    expect(jobId).toBe('existing-correlation-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('suppresses worker scans when alert correlation is disabled for the org', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const result = await runAlertCorrelationForDevice({ orgId: 'org-1', deviceId: 'device-1' });

    expect(result).toEqual({ scanned: 0, created: 0 });
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith('org-1', 'ml.alert_correlation.enabled');
  });
});
