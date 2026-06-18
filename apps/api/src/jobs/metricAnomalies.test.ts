import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock, getRepeatableJobsMock, removeRepeatableByKeyMock, attachWorkerObservabilityMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
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

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
}));

vi.mock('../services/metricAnomalies', () => ({
  detectMetricAnomaliesRange: vi.fn(),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

import {
  buildMetricAnomalyJobId,
  enqueueMetricAnomalyBackfill,
  initializeMetricAnomaliesWorker,
  shutdownMetricAnomaliesWorker,
} from './metricAnomalies';

describe('metric anomalies queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getRepeatableJobsMock.mockReset();
    removeRepeatableByKeyMock.mockReset();
    attachWorkerObservabilityMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-anomaly-job' });
    getRepeatableJobsMock.mockResolvedValue([]);
    await shutdownMetricAnomaliesWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id per org and time range', async () => {
    const from = new Date('2026-06-18T11:00:00.000Z');
    const to = new Date('2026-06-18T12:00:00.000Z');
    const jobId = buildMetricAnomalyJobId('org-1', from, to);

    await enqueueMetricAnomalyBackfill({ orgId: 'org-1', from, to });

    expect(jobId).toBe('metric-anomalies-org-1-20260618T110000000Z-20260618T120000000Z');
    expect(addMock).toHaveBeenCalledWith(
      'detect-org-range',
      expect.objectContaining({
        type: 'detect-org-range',
        orgId: 'org-1',
        from: '2026-06-18T11:00:00.000Z',
        to: '2026-06-18T12:00:00.000Z',
      }),
      expect.objectContaining({ jobId }),
    );
  });

  it('reuses an existing queued backfill job for the same org and time range', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-anomaly-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await enqueueMetricAnomalyBackfill({
      orgId: 'org-1',
      from: new Date('2026-06-18T11:00:00.000Z'),
      to: new Date('2026-06-18T12:00:00.000Z'),
    });

    expect(jobId).toBe('existing-anomaly-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('attaches worker observability during initialization', async () => {
    await initializeMetricAnomaliesWorker();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'metricAnomaliesWorker');
    expect(addMock).toHaveBeenCalledWith(
      'scan-orgs',
      expect.objectContaining({ type: 'scan-orgs' }),
      expect.objectContaining({ jobId: 'metric-anomalies-scan-orgs' }),
    );
  });
});
