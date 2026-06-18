import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getJobMock,
  addMock,
  addBulkMock,
  closeMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  attachWorkerObservabilityMock,
  selectMock,
  fromMock,
  whereMock,
  groupByMock,
  workerProcessorMock,
} = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  groupByMock: vi.fn(),
  workerProcessorMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = addBulkMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
    close = closeMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => unknown) {
      workerProcessorMock.mockImplementation(processor);
    }

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
  db: { select: selectMock },
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
    addBulkMock.mockReset();
    closeMock.mockReset();
    getRepeatableJobsMock.mockReset();
    removeRepeatableByKeyMock.mockReset();
    attachWorkerObservabilityMock.mockReset();
    selectMock.mockReset();
    fromMock.mockReset();
    whereMock.mockReset();
    groupByMock.mockReset();
    workerProcessorMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-anomaly-job' });
    addBulkMock.mockResolvedValue([]);
    getRepeatableJobsMock.mockResolvedValue([]);
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock });
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
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
    const scanData = addMock.mock.calls.find(([name]) => name === 'scan-orgs')?.[1];
    expect(scanData).not.toHaveProperty('queuedAt');
  });

  it('uses the worker execution time when fan-out repeat scans create anomaly ranges', async () => {
    vi.setSystemTime(new Date('2026-06-18T12:01:00.000Z'));
    await initializeMetricAnomaliesWorker();
    addBulkMock.mockClear();

    vi.setSystemTime(new Date('2026-06-18T12:26:10.000Z'));
    await workerProcessorMock({
      data: {
        type: 'scan-orgs',
        queuedAt: '2026-06-18T12:01:00.000Z',
        lookbackMinutes: 30,
      },
    });

    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'detect-org-range',
        data: expect.objectContaining({
          orgId: 'org-1',
          from: '2026-06-18T11:55:00.000Z',
          to: '2026-06-18T12:25:00.000Z',
          queuedAt: '2026-06-18T12:26:10.000Z',
        }),
        opts: expect.objectContaining({
          jobId: 'metric-anomalies-org-1-20260618T115500000Z-20260618T122500000Z',
        }),
      }),
    ]);
  });
});
