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
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
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
  runOutsideDbContextMock: vi.fn(<T>(fn: () => T) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../db/schema', () => ({
  devices: {},
}));

vi.mock('../services/metricRollups', () => ({
  rollupDeviceMetricsRange: vi.fn(),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

import {
  buildMetricRollupJobId,
  enqueueMetricRollupBackfill,
  initializeMetricRollupsWorker,
  shutdownMetricRollupsWorker,
} from './metricRollups';

describe('metric rollups queue helpers', () => {
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
    runOutsideDbContextMock.mockClear();
    withSystemDbAccessContextMock.mockClear();
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T) => fn());
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-rollup-job' });
    addBulkMock.mockResolvedValue([]);
    getRepeatableJobsMock.mockResolvedValue([]);
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock });
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
    await shutdownMetricRollupsWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id per org and time range', async () => {
    const from = new Date('2026-06-18T11:00:00.000Z');
    const to = new Date('2026-06-18T12:00:00.000Z');
    const jobId = buildMetricRollupJobId('org-1', from, to);

    await enqueueMetricRollupBackfill({ orgId: 'org-1', from, to });

    expect(jobId).toBe('metric-rollups-org-1-20260618T110000000Z-20260618T120000000Z');
    expect(addMock).toHaveBeenCalledWith(
      'rollup-org-range',
      expect.objectContaining({
        type: 'rollup-org-range',
        orgId: 'org-1',
        from: '2026-06-18T11:00:00.000Z',
        to: '2026-06-18T12:00:00.000Z',
      }),
      expect.objectContaining({ jobId }),
    );
  });

  it('reuses an existing queued backfill job for the same org and time range', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-rollup-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await enqueueMetricRollupBackfill({
      orgId: 'org-1',
      from: new Date('2026-06-18T11:00:00.000Z'),
      to: new Date('2026-06-18T12:00:00.000Z'),
    });

    expect(jobId).toBe('existing-rollup-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('attaches worker observability during initialization', async () => {
    await initializeMetricRollupsWorker();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'metricRollupsWorker');
    expect(addMock).toHaveBeenCalledWith(
      'scan-orgs',
      expect.objectContaining({ type: 'scan-orgs' }),
      expect.objectContaining({ jobId: 'metric-rollups-scan-orgs' }),
    );
    const scanData = addMock.mock.calls.find(([name]) => name === 'scan-orgs')?.[1];
    expect(scanData).not.toHaveProperty('queuedAt');
  });

  it('uses the worker execution time when fan-out repeat scans create rollup ranges', async () => {
    vi.setSystemTime(new Date('2026-06-18T12:01:00.000Z'));
    await initializeMetricRollupsWorker();
    addBulkMock.mockClear();

    vi.setSystemTime(new Date('2026-06-18T12:26:10.000Z'));
    await workerProcessorMock({
      data: {
        type: 'scan-orgs',
        queuedAt: '2026-06-18T12:01:00.000Z',
        lookbackMinutes: 15,
      },
    });

    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'rollup-org-range',
        data: expect.objectContaining({
          orgId: 'org-1',
          from: '2026-06-18T12:10:00.000Z',
          to: '2026-06-18T12:25:00.000Z',
          queuedAt: '2026-06-18T12:26:10.000Z',
        }),
        opts: expect.objectContaining({
          jobId: 'metric-rollups-org-1-20260618T121000000Z-20260618T122500000Z',
        }),
      }),
    ]);
  });

  it('does not hold system DB context while scan fan-out enqueues BullMQ jobs', async () => {
    const callOrder: string[] = [];
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T): T => {
      callOrder.push('runOutsideDbContext');
      return fn();
    });
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      callOrder.push('withSystemDbAccessContext:start');
      const result = await fn();
      callOrder.push('withSystemDbAccessContext:end');
      return result;
    });
    addBulkMock.mockImplementation(async () => {
      callOrder.push('addBulk');
      return [];
    });

    await initializeMetricRollupsWorker();
    addBulkMock.mockClear();
    await workerProcessorMock({
      data: {
        type: 'scan-orgs',
        lookbackMinutes: 15,
      },
    });

    expect(callOrder).toEqual([
      'runOutsideDbContext',
      'withSystemDbAccessContext:start',
      'withSystemDbAccessContext:end',
      'addBulk',
    ]);
  });
});
