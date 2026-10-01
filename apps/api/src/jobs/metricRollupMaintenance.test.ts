import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  runMaintenanceMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runMaintenanceMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
  };
});

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

vi.mock('../services/metricRollupMaintenance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/metricRollupMaintenance')>();
  return {
    ...actual,
    runMetricRollupMaintenance: (...args: unknown[]) => runMaintenanceMock(...(args as [])),
  };
});

import {
  __testOnly,
  createMetricRollupMaintenanceWorker,
  initializeMetricRollupMaintenanceWorker,
  scheduleMetricRollupMaintenance,
  shutdownMetricRollupMaintenanceWorker,
} from './metricRollupMaintenance';

const ORIGINAL_FLAG = process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED;

function maintenanceResult(overrides: Record<string, unknown> = {}) {
  return {
    ensuredPartitions: ['metric_rollups_y2026m06'],
    droppedPartitions: [],
    droppedBucketPartitions: ['metric_rollups_y2026m03_5m'],
    compactedPartitions: [],
    defaultPartitionRowsDeleted: 4,
    defaultPartitionDrain: {
      blockedMonths: [],
      resumed: false,
      swapped: false,
      monthsCreated: [],
      rowsMoved: 0,
      rowsDiscarded: 4,
      completed: true,
    },
    retentionDays: { fiveMinute: 90, hourly: 548, daily: 1095 },
    cutoffs: { fiveMinute: '', hourly: '', daily: '' },
    failures: [],
    durationMs: 12,
    ...overrides,
  };
}

describe('metric rollup maintenance worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getRepeatableJobsMock.mockResolvedValue([]);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    addMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    runMaintenanceMock.mockResolvedValue(maintenanceResult());
    capturedWorkerProcessor.current = null;
    delete process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED;
  });

  afterEach(async () => {
    await shutdownMetricRollupMaintenanceWorker();
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED;
    } else {
      process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED = ORIGINAL_FLAG;
    }
  });

  it('exposes stable queue metadata for scheduling', () => {
    expect(__testOnly.QUEUE_NAME).toBe('metric-rollup-maintenance');
    expect(__testOnly.JOB_NAME).toBe('metric-rollup-maintenance');
    expect(__testOnly.REPEAT_JOB_ID).toBe('metric-rollup-maintenance');
    expect(__testOnly.DAILY_CRON).toBe('13 3 * * *');
  });

  it('isMaintenanceEnabled defaults ON and accepts standard falsy values', () => {
    delete process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED;
    expect(__testOnly.isMaintenanceEnabled()).toBe(true);
    process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED = 'false';
    expect(__testOnly.isMaintenanceEnabled()).toBe(false);
    process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED = '0';
    expect(__testOnly.isMaintenanceEnabled()).toBe(false);
    process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED = 'true';
    expect(__testOnly.isMaintenanceEnabled()).toBe(true);
  });

  it('registers a daily repeatable job with a stable jobId', async () => {
    await scheduleMetricRollupMaintenance();

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      'metric-rollup-maintenance',
      expect.objectContaining({
        partitionMonthsAhead: expect.any(Number),
        deleteBatchSize: expect.any(Number),
      }),
      expect.objectContaining({
        jobId: 'metric-rollup-maintenance',
        repeat: { pattern: '13 3 * * *' },
      }),
    );
  });

  it('removes stale repeatables for the same job before scheduling', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'metric-rollup-maintenance', key: 'old-key' },
      { name: 'other-job', key: 'keep-key' },
    ]);

    await scheduleMetricRollupMaintenance();

    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('skips schedule registration when disabled by env', async () => {
    process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED = 'off';

    await scheduleMetricRollupMaintenance();

    expect(addMock).not.toHaveBeenCalled();
  });

  it('runs maintenance without an outer DB context (every step owns its own short transaction)', async () => {
    createMetricRollupMaintenanceWorker();
    expect(capturedWorkerProcessor.current).toBeTypeOf('function');

    const result = await capturedWorkerProcessor.current!({
      id: 'job-1',
      name: 'metric-rollup-maintenance',
      data: {
        requestedAt: '2026-06-18T12:00:00.000Z',
        deleteBatchSize: 250,
        // Stored in pre-#7531 repeatable jobs; must be ignored, not forwarded.
        maxDeleteBatches: 2,
      },
    });

    // #7531: one outer transaction would hold every partition DROP's
    // ACCESS EXCLUSIVE lock on metric_rollups until the end of the run.
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(runMaintenanceMock).toHaveBeenCalledWith({
      now: new Date('2026-06-18T12:00:00.000Z'),
      partitionMonthsBack: undefined,
      partitionMonthsAhead: undefined,
      deleteBatchSize: 250,
    });
    expect(result).toMatchObject({ ensuredPartitions: ['metric_rollups_y2026m06'] });
  });

  it('fails the job when a retention step failed, after the rest of the run completed', async () => {
    runMaintenanceMock.mockResolvedValue(
      maintenanceResult({
        failures: [{ step: 'compact', partition: 'metric_rollups_y2026m05', error: 'lock timeout' }],
      }),
    );
    createMetricRollupMaintenanceWorker();

    await expect(
      capturedWorkerProcessor.current!({ id: 'job-3', name: 'metric-rollup-maintenance', data: {} }),
    ).rejects.toThrow(/1 step\(s\) failed: compact metric_rollups_y2026m05: lock timeout/);
  });

  it('ignores unknown job names without running maintenance', async () => {
    createMetricRollupMaintenanceWorker();

    const result = await capturedWorkerProcessor.current!({
      id: 'job-2',
      name: 'something-else',
      data: {},
    });

    expect(runMaintenanceMock).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
  });

  it('initializes, schedules, and shuts down idempotently', async () => {
    await initializeMetricRollupMaintenanceWorker();
    expect(addMock).toHaveBeenCalledTimes(1);

    await shutdownMetricRollupMaintenanceWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);

    await shutdownMetricRollupMaintenanceWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });
});
