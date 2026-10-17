import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { EDR_DETECTION_STATUSES, EDR_OPEN_DETECTION_STATUSES } from '@breeze/shared';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  attachWorkerObservabilityMock,
  recordRetentionRunMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, _label?: string) => fn()),
  dbExecuteMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  recordRetentionRunMock: vi.fn(),
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
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../services/retentionMetrics', () => ({
  recordRetentionRun: (...args: unknown[]) => recordRetentionRunMock(...(args as [])),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

import {
  __testOnly,
  createEdrDetectionRetentionWorker,
  initializeEdrDetectionRetention,
  shutdownEdrDetectionRetention,
} from './edrDetectionRetention';

const compileFirstStatement = () => {
  const compiledArg = dbExecuteMock.mock.calls[0]![0] as SQL;
  return new PgDialect().sqlToQuery(compiledArg);
};

describe('EDR detection retention worker', () => {
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
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await shutdownEdrDetectionRetention();
  });

  it('registers a repeatable pruning job and attaches observability', async () => {
    await initializeEdrDetectionRetention();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'edrDetectionRetentionWorker');
    expect(addMock).toHaveBeenCalledWith(
      'cleanup',
      expect.objectContaining({
        batchSize: __testOnly.BATCH_SIZE,
        maxBatches: __testOnly.MAX_BATCHES,
      }),
      expect.objectContaining({
        repeat: expect.objectContaining({ pattern: expect.any(String) }),
      }),
    );
  });

  describe('delete predicate', () => {
    it('prunes exactly the four terminal statuses and never open / in_progress / unknown', () => {
      expect([...__testOnly.PRUNABLE_STATUSES].sort()).toEqual(
        ['dismissed', 'false_positive', 'mitigated', 'resolved'],
      );
      for (const status of __testOnly.PRUNABLE_STATUSES) {
        expect(EDR_DETECTION_STATUSES).toContain(status);
        expect(EDR_OPEN_DETECTION_STATUSES as readonly string[]).not.toContain(status);
      }
      // Every status the feed treats as still-open is excluded.
      for (const open of EDR_OPEN_DETECTION_STATUSES) {
        expect(__testOnly.PRUNABLE_STATUSES as readonly string[]).not.toContain(open);
      }
      // `unknown` is explicitly kept: we could not classify it, so we do not destroy it.
      expect(__testOnly.PRUNABLE_STATUSES as readonly string[]).not.toContain('unknown');
    });

    it('retains for exactly 180 days', () => {
      expect(__testOnly.EDR_DETECTION_RETENTION_DAYS).toBe(180);
    });

    it('compiles a WHERE that binds only the terminal statuses and the COALESCE age expression', async () => {
      dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
      createEdrDetectionRetentionWorker();

      await capturedWorkerProcessor.current!({ data: { batchSize: 100, maxBatches: 5 } });

      const { sql: text, params } = compileFirstStatement();
      expect(text).toContain('DELETE FROM edr_detections');
      expect(text).toMatch(/status IN \(\$\d+, \$\d+, \$\d+, \$\d+\)/);
      expect(text).toContain('COALESCE(resolved_at, last_vendor_update_at, updated_at)');
      expect(text).toMatch(/COALESCE\(resolved_at, last_vendor_update_at, updated_at\) < \$\d+::timestamptz/);
      for (const status of ['resolved', 'dismissed', 'false_positive', 'mitigated']) {
        expect(params).toContain(status);
      }
      for (const status of ['open', 'in_progress', 'unknown']) {
        expect(params).not.toContain(status);
      }
      // The only non-status, non-limit param is the cutoff.
      expect(text).not.toContain('edr_actions');
    });

    it('row classification: resolved@181d pruned, resolved@179d kept, open@400d kept, unknown kept', () => {
      const now = Date.parse('2026-10-12T00:00:00Z');
      const day = 86_400_000;
      const cutoff = __testOnly.cutoffIso(now);
      const row = (status: string, ageDays: number) => ({
        status,
        // resolved_at NULL, last_vendor_update_at NULL -> falls through to updated_at
        updatedAt: new Date(now - ageDays * day).toISOString(),
      });
      const wouldPrune = (r: { status: string; updatedAt: string }) =>
        (__testOnly.PRUNABLE_STATUSES as readonly string[]).includes(r.status) && r.updatedAt < cutoff;

      expect(wouldPrune(row('resolved', 181))).toBe(true);
      expect(wouldPrune(row('resolved', 179))).toBe(false);
      expect(wouldPrune(row('open', 400))).toBe(false);
      expect(wouldPrune(row('in_progress', 400))).toBe(false);
      expect(wouldPrune(row('unknown', 400))).toBe(false);
      for (const s of ['mitigated', 'dismissed', 'false_positive']) {
        expect(wouldPrune(row(s, 181))).toBe(true);
        expect(wouldPrune(row(s, 179))).toBe(false);
      }
    });
  });

  it('computes a cutoff exactly 180 days in the PAST', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    createEdrDetectionRetentionWorker();
    const before = Date.now();

    await capturedWorkerProcessor.current!({ data: { batchSize: 4, maxBatches: 5 } });

    const iso = JSON.stringify(dbExecuteMock.mock.calls).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
    expect(iso).toBeTruthy();
    const ageDays = (before - new Date(iso!).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(179.9);
    expect(ageDays).toBeLessThan(180.1);
  });

  it('deletes in batches, each inside its own system DB context, and records the run', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 2 });
    createEdrDetectionRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { batchSize: 4, maxBatches: 5 },
    });

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(3);
    expect(withSystemDbAccessContextMock.mock.calls.map((c) => c[1])).toEqual(
      Array(3).fill('edrDetectionRetention.prune'),
    );
    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      deletedCount: 10,
      batches: 3,
      hasMore: false,
      retentionDays: 180,
    });
    expect(recordRetentionRunMock).toHaveBeenCalledWith('edr_detection_retention', {
      rowsDeleted: 10,
      incomplete: false,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stops at maxBatches, reports hasMore, and warns about the backlog', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 });
    createEdrDetectionRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { batchSize: 4, maxBatches: 2 },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ deletedCount: 8, batches: 2, hasMore: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('edr_detections');
    expect(recordRetentionRunMock).toHaveBeenCalledWith('edr_detection_retention', {
      rowsDeleted: 8,
      incomplete: true,
    });
  });

  it('falls back to the module batch defaults when the payload omits them', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    createEdrDetectionRetentionWorker();

    await capturedWorkerProcessor.current!({ data: {} });

    const { params } = compileFirstStatement();
    expect(params).toContain(__testOnly.BATCH_SIZE);
  });
});
