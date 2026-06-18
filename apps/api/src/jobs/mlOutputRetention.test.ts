import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  attachWorkerObservabilityMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dbExecuteMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: { data: Record<string, unknown> }) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: Record<string, unknown> }) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

import {
  __testOnly,
  createMlOutputRetentionWorker,
  extractMlOutputRetentionRowCount,
  initializeMlOutputRetention,
  shutdownMlOutputRetention,
} from './mlOutputRetention';

describe('ML output retention worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    addMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
    capturedWorkerProcessor.current = null;
  });

  afterEach(async () => {
    await shutdownMlOutputRetention();
  });

  it('extracts row counts from supported driver result shapes', () => {
    expect(extractMlOutputRetentionRowCount({ rowCount: 4, count: 2 })).toBe(4);
    expect(extractMlOutputRetentionRowCount({ count: 3 })).toBe(3);
    expect(extractMlOutputRetentionRowCount([{}, {}])).toBe(2);
    expect(extractMlOutputRetentionRowCount({})).toBe(0);
  });

  it('registers a repeatable pruning job with a stable jobId', async () => {
    await initializeMlOutputRetention();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'mlOutputRetention');
    expect(addMock).toHaveBeenCalledWith(
      __testOnly.JOB_NAME,
      expect.objectContaining({
        retentionDays: __testOnly.DEFAULT_RETENTION_DAYS,
        batchSize: __testOnly.BATCH_SIZE,
        maxBatches: __testOnly.MAX_BATCHES,
      }),
      expect.objectContaining({
        jobId: __testOnly.REPEAT_JOB_ID,
        repeat: { every: __testOnly.RETENTION_INTERVAL_MS },
      }),
    );
  });

  it('prunes remediation suggestions and metric anomalies in bounded ctid batches inside system DB context', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    createMlOutputRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 30, batchSize: 4, maxBatches: 3 },
    });

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain('DELETE FROM remediation_suggestions');
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain('DELETE FROM metric_anomalies');
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain('SELECT ctid');
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain('created_at <');
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain('detected_at <');
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain('LIMIT');
    expect(result).toMatchObject({
      retentionDays: 30,
      deleted: 5,
      batchSize: 4,
      maxBatches: 3,
      hasMore: false,
      tables: [
        { table: 'remediation_suggestions', deleted: 5, batches: 2, hasMore: false },
        { table: 'metric_anomalies', deleted: 0, batches: 1, hasMore: false },
      ],
    });
  });

  it('reports hasMore when any output table exhausts the configured batch cap', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 1 });
    createMlOutputRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 30, batchSize: 4, maxBatches: 2 },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      deleted: 9,
      hasMore: true,
      tables: [
        { table: 'remediation_suggestions', deleted: 8, batches: 2, hasMore: true },
        { table: 'metric_anomalies', deleted: 1, batches: 1, hasMore: false },
      ],
    });
  });
});
