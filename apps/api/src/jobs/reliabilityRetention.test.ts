import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dbExecuteMock: vi.fn(),
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

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import {
  __testOnly,
  createReliabilityRetentionWorker,
  extractReliabilityRetentionRowCount,
  initializeReliabilityRetention,
  shutdownReliabilityRetention,
} from './reliabilityRetention';

describe('reliability retention worker', () => {
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
    await shutdownReliabilityRetention();
  });

  it('extracts row counts from supported driver result shapes', () => {
    expect(extractReliabilityRetentionRowCount({ rowCount: 4, count: 2 })).toBe(4);
    expect(extractReliabilityRetentionRowCount({ count: 3 })).toBe(3);
    expect(extractReliabilityRetentionRowCount([{}, {}])).toBe(2);
    expect(extractReliabilityRetentionRowCount({})).toBe(0);
  });

  it('registers a repeatable pruning job with a stable jobId', async () => {
    await initializeReliabilityRetention();

    expect(addMock).toHaveBeenCalledWith(
      __testOnly.JOB_NAME,
      expect.objectContaining({
        retentionDays: expect.any(Number),
        batchSize: __testOnly.BATCH_SIZE,
        maxBatches: __testOnly.MAX_BATCHES,
      }),
      expect.objectContaining({
        jobId: __testOnly.REPEAT_JOB_ID,
        repeat: { every: 24 * 60 * 60 * 1000 },
      }),
    );
  });

  it('prunes reliability history in bounded batches inside system DB context', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 1 });
    createReliabilityRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 30, batchSize: 4, maxBatches: 3 },
    });

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      retentionDays: 30,
      deleted: 5,
      batches: 2,
      batchSize: 4,
      maxBatches: 3,
      hasMore: false,
    });
  });

  it('reports hasMore when every allowed batch is full', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 });
    createReliabilityRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 30, batchSize: 4, maxBatches: 2 },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      deleted: 8,
      batches: 2,
      hasMore: true,
    });
  });
});
