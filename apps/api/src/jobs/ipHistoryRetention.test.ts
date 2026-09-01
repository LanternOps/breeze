import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  captureExceptionMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, _label?: string) => fn()),
  dbExecuteMock: vi.fn(),
  captureExceptionMock: vi.fn(),
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
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) => withSystemDbAccessContextMock(fn, label),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
  captureMessage: vi.fn(),
}));

import {
  __testOnly,
  createIPHistoryRetentionWorker,
  initializeIPHistoryRetention,
  shutdownIPHistoryRetention,
} from './ipHistoryRetention';

describe('IP history retention worker', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

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
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await shutdownIPHistoryRetention();
  });

  it('registers a repeatable pruning job carrying batchSize/maxBatches', async () => {
    await initializeIPHistoryRetention();

    expect(addMock).toHaveBeenCalledWith(
      'cleanup',
      expect.objectContaining({
        retentionDays: __testOnly.DEFAULT_RETENTION_DAYS,
        batchSize: __testOnly.BATCH_SIZE,
        maxBatches: __testOnly.MAX_BATCHES,
      }),
      expect.objectContaining({
        repeat: expect.objectContaining({ pattern: expect.any(String) }),
      }),
    );
  });

  it('deletes inactive device_ip_history rows in bounded ctid batches, inside system DB context', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 2 });
    createIPHistoryRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 90, batchSize: 4, maxBatches: 5 },
    });

    // ONE short context per batch, not one spanning the whole sweep:
    // withDbAccessContext opens a transaction, so a single outer context would
    // hold every lock until the last batch committed (worse than the unbounded
    // DELETE this replaced).
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(3);
    expect(withSystemDbAccessContextMock.mock.calls.map((c) => c[1])).toEqual(
      Array(3).fill('ipHistoryRetention.prune'),
    );
    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    const sqlDump = JSON.stringify(dbExecuteMock.mock.calls);
    expect(sqlDump).toContain('DELETE FROM');
    expect(sqlDump).toContain('device_ip_history');
    expect(sqlDump).toContain('SELECT ctid');
    expect(sqlDump).toContain('is_active = false AND deactivated_at <=');
    expect(sqlDump).toContain('LIMIT');
    expect(result).toMatchObject({
      deletedCount: 10,
      batches: 3,
      hasMore: false,
      retentionDays: 90,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stops at maxBatches, reports hasMore, and warns about the backlog', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 });
    createIPHistoryRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 90, batchSize: 4, maxBatches: 2 },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      deletedCount: 8,
      batches: 2,
      hasMore: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('device_ip_history');
  });

  // The cutoff is the value that decides which rows die, and nothing else in
  // this file looks at it: asserting `retentionDays` in the result only echoes
  // the input back. A sign flip here ("now + N days") deletes the whole table
  // and every other assertion still passes.
  it('computes a cutoff exactly retentionDays in the PAST', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    createIPHistoryRetentionWorker();
    const before = Date.now();

    await capturedWorkerProcessor.current!({ data: { retentionDays: 30, batchSize: 4, maxBatches: 5 } });

    const iso = JSON.stringify(dbExecuteMock.mock.calls).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
    expect(iso).toBeTruthy();
    const ageDays = (before - new Date(iso!).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);
  });

  // Repeatable jobs already queued in Redis from the previous release carry no
  // batchSize/maxBatches. Until initialize* re-registers them, the worker runs
  // this branch — which every other test in this file skips by passing them.
  it('falls back to the module batch defaults when the payload omits them', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    createIPHistoryRetentionWorker();

    const result = await capturedWorkerProcessor.current!({ data: {} });

    const { params } = new PgDialect().sqlToQuery(dbExecuteMock.mock.calls[0]![0] as SQL);
    expect(params).toContain(__testOnly.BATCH_SIZE);
    expect(result).toMatchObject({ retentionDays: __testOnly.DEFAULT_RETENTION_DAYS });
  });

  // A 0 in the payload must fall back, not clamp to a 1-day window — clamping
  // would prune nearly the entire table on the next run.
  it('falls back to the default window when the payload asks for zero retention', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    createIPHistoryRetentionWorker();
    const before = Date.now();

    const result = await capturedWorkerProcessor.current!({ data: { retentionDays: 0, batchSize: 4, maxBatches: 5 } });

    expect(result).toMatchObject({ retentionDays: __testOnly.DEFAULT_RETENTION_DAYS });
    const iso = JSON.stringify(dbExecuteMock.mock.calls).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
    const ageDays = (before - new Date(iso!).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(90 - 0.1);
  });

});
