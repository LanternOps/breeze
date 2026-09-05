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
  attachWorkerObservabilityMock,
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

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

import {
  __testOnly,
  createIntentOutboxRetentionWorker,
  initializeIntentOutboxRetention,
  shutdownIntentOutboxRetention,
} from './intentOutboxRetention';
import { MAX_PUBLISH_ATTEMPTS } from './intentOutboxPublisher';

/**
 * Drizzle's SQL objects carry a circular `table` back-reference (column ->
 * table -> columns -> column) once a query is built off a schema column
 * object (e.g. `${ticketOutbox.publishedAt}`), unlike agentLogRetention.ts's
 * bare `"timestamp"` string literal. `JSON.stringify` over the raw mock
 * calls throws `Converting circular structure to JSON` here, so assertions
 * render each call through the real dialect instead (same approach as the
 * `falls back to the module batch defaults` test below already used).
 */
function renderCalls(calls: unknown[][]): { sql: string; params: unknown[] } {
  const dialect = new PgDialect();
  let sql = '';
  const params: unknown[] = [];
  for (const call of calls) {
    const rendered = dialect.sqlToQuery(call[0] as SQL);
    sql += `${rendered.sql}\n`;
    params.push(...rendered.params);
  }
  return { sql, params };
}

describe('Intent outbox retention worker', () => {
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
    await shutdownIntentOutboxRetention();
  });

  it('registers a repeatable pruning job carrying batchSize/maxBatches', async () => {
    await initializeIntentOutboxRetention();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'intentOutboxRetention');
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

  it('deletes intent_outbox in bounded ctid batches, inside system DB context', async () => {
    // Delivered branch: 3 batches (4, 4, 2). The stuck branch then runs as a
    // separate pass (see the two-query split below) and finds nothing —
    // falls through to the persistent { rowCount: 0 } default from beforeEach.
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 2 });
    createIntentOutboxRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 14, batchSize: 4, maxBatches: 5 },
    });

    // ONE short context per batch, not one spanning the whole sweep — same
    // lock-duration reasoning as agentLogRetention.ts / retentionBatch.ts.
    // 3 delivered-branch batches + 1 stuck-branch batch (finds nothing, stops
    // after its first short batch) = 4 contexts total.
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(4);
    expect(withSystemDbAccessContextMock.mock.calls.map((c) => c[1])).toEqual([
      ...Array(3).fill('intentOutboxRetention.prune.delivered'),
      'intentOutboxRetention.prune.stuck',
    ]);
    expect(dbExecuteMock).toHaveBeenCalledTimes(4);
    const { sql: sqlDump } = renderCalls(dbExecuteMock.mock.calls as unknown[][]);
    expect(sqlDump).toContain('DELETE FROM');
    expect(sqlDump).toContain('intent_outbox');
    expect(sqlDump).toContain('SELECT ctid');
    expect(sqlDump).toContain('published_at');
    expect(sqlDump).toContain('publish_attempts');
    expect(sqlDump).toContain('created_at');
    expect(sqlDump).toContain('LIMIT');
    expect(result).toMatchObject({
      deletedCount: 10,
      batches: 4,
      hasMore: false,
      retentionDays: 14,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // The two branches are now separate DELETE passes (not one OR'd predicate)
  // so a stuck-row purge is visible on its own — see pruneIntentOutbox's doc
  // comment. This asserts the split rather than one combined query.
  it('issues the delivered and stuck-row predicates as separate queries, the stuck one bounded by MAX_PUBLISH_ATTEMPTS', async () => {
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
    createIntentOutboxRetentionWorker();

    await capturedWorkerProcessor.current!({ data: { retentionDays: 14, batchSize: 4, maxBatches: 5 } });

    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    const delivered = new PgDialect().sqlToQuery(dbExecuteMock.mock.calls[0]![0] as SQL);
    const stuck = new PgDialect().sqlToQuery(dbExecuteMock.mock.calls[1]![0] as SQL);

    // Delivered branch: published_at IS NOT NULL AND published_at < cutoff —
    // no publish_attempts/created_at involvement at all.
    expect(delivered.sql).toMatch(/"published_at" is not null/i);
    expect(delivered.sql).not.toMatch(/publish_attempts/i);

    // Stuck branch: unpublished, attempts exhausted, aged off created_at.
    expect(stuck.sql).toMatch(/"published_at" is null/i);
    expect(stuck.sql).toMatch(/"publish_attempts" >/i);
    expect(stuck.sql).toMatch(/"created_at" </i);
    expect(stuck.params).toContain(MAX_PUBLISH_ATTEMPTS);
  });

  it('warns specifically about a stuck-row purge, distinct from the generic backlog warning', async () => {
    // Delivered branch: nothing. Stuck branch: 1 permanently-failed row.
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });
    createIntentOutboxRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 14, batchSize: 4, maxBatches: 5 },
    });

    expect(result).toMatchObject({ deletedCount: 1, hasMore: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('permanently-failed');
    expect(warnSpy.mock.calls[0][0]).toContain('1');
  });

  it('stops at maxBatches, reports hasMore, and warns about the backlog', async () => {
    // Delivered branch hits the 2-batch cap with a full final batch (hasMore).
    // Stuck branch then finds nothing and stops after its own short batch.
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 4 });
    createIntentOutboxRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { retentionDays: 14, batchSize: 4, maxBatches: 2 },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      deletedCount: 8,
      batches: 3,
      hasMore: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('intent_outbox');
  });

  // The cutoff is the value that decides which rows die, and nothing else in
  // this file looks at it: asserting `retentionDays` in the result only echoes
  // the input back. A sign flip here ("now + N days") deletes the whole table
  // and every other assertion still passes.
  it('computes a cutoff exactly retentionDays in the PAST', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    createIntentOutboxRetentionWorker();
    const before = Date.now();

    await capturedWorkerProcessor.current!({ data: { retentionDays: 30, batchSize: 4, maxBatches: 5 } });

    const { params } = renderCalls(dbExecuteMock.mock.calls as unknown[][]);
    const iso = params.map(String).find((p) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(p));
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
    createIntentOutboxRetentionWorker();

    const result = await capturedWorkerProcessor.current!({ data: {} });

    const { params } = new PgDialect().sqlToQuery(dbExecuteMock.mock.calls[0]![0] as SQL);
    expect(params).toContain(__testOnly.BATCH_SIZE);
    expect(result).toMatchObject({ retentionDays: __testOnly.DEFAULT_RETENTION_DAYS });
  });

  // A 0 in the payload must fall back, not clamp to a 1-day window — clamping
  // would prune nearly the entire table on the next run.
  it('falls back to the default window when the payload asks for zero retention', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    createIntentOutboxRetentionWorker();
    const before = Date.now();

    const result = await capturedWorkerProcessor.current!({ data: { retentionDays: 0, batchSize: 4, maxBatches: 5 } });

    expect(result).toMatchObject({ retentionDays: __testOnly.DEFAULT_RETENTION_DAYS });
    const { params } = renderCalls(dbExecuteMock.mock.calls as unknown[][]);
    const iso = params.map(String).find((p) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(p));
    const ageDays = (before - new Date(iso!).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(14 - 0.1);
  });
});
