/**
 * Wisp W05b Task 10 — the daily concern retention job. BullMQ, the reaper and
 * `wispEnabled()` are mocked; the `concern_outcome` memory delete is rendered
 * through the real Postgres dialect so the cutoff and block type are asserted
 * on the SQL itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  enabled: true,
  statements: [] as Array<{ text: string; params: unknown[] }>,
  memoryDeleteCounts: [] as number[],
  memoryFails: false,
  contexts: [] as string[],
  reapConcerns: vi.fn(async (_now: Date, _opts?: unknown) => ({ deleted: 0, subjectGone: 0 })),
  captureException: vi.fn(),
  add: vi.fn(),
  getRepeatableJobs: vi.fn(async () => [] as Array<{ key: string }>),
  removeRepeatableByKey: vi.fn(),
  queueClose: vi.fn(),
  workerClose: vi.fn(),
  order: [] as string[],
  processor: { current: null as null | ((job: { data: unknown }) => Promise<unknown>) },
}));

const dialect = new PgDialect();

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => { h.order.push('add'); return h.add(...args); };
    getRepeatableJobs = () => h.getRepeatableJobs();
    removeRepeatableByKey = (key: string) => { h.order.push(`remove:${key}`); return h.removeRepeatableByKey(key); };
    close = () => h.queueClose();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      h.processor.current = processor;
    }
    on = vi.fn();
    close = () => h.workerClose();
  },
  Job: class {},
}));

vi.mock('../config/env', () => ({ wispEnabled: () => h.enabled }));

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      h.statements.push({ text, params });
      if (h.memoryFails) throw new Error('memory boom');
      return { count: h.memoryDeleteCounts.shift() ?? 0 };
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>, label?: string) => {
    h.contexts.push(label ?? '');
    return fn();
  },
}));

vi.mock('../services/wisp/concernReaper', () => ({
  reapConcerns: (now: Date, opts?: unknown) => h.reapConcerns(now, opts),
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => h.captureException(...args),
  captureMessage: vi.fn(),
}));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { jobSchedule } from './scheduleRegistry';
import {
  WISP_CONCERN_OUTCOME_MEMORY_RETENTION_DAYS,
  WISP_CONCERN_RESOLVED_RETENTION_DAYS,
  initializeWispConcernRetention,
  runWispConcernRetention,
  shutdownWispConcernRetention,
} from './wispConcernRetention';

const NOW = new Date('2026-10-24T21:23:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function memoryDeletes() {
  return h.statements.filter((s) => /DELETE FROM ai_memory_blocks/.test(s.text));
}

beforeEach(async () => {
  await shutdownWispConcernRetention();
  h.enabled = true;
  h.statements = [];
  h.memoryDeleteCounts = [];
  h.memoryFails = false;
  h.contexts = [];
  h.order = [];
  h.reapConcerns.mockReset();
  h.reapConcerns.mockImplementation(async () => ({ deleted: 0, subjectGone: 0 }));
  h.captureException.mockReset();
  h.add.mockReset();
  h.getRepeatableJobs.mockReset();
  h.getRepeatableJobs.mockImplementation(async () => []);
  h.removeRepeatableByKey.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('runWispConcernRetention', () => {
  it('pins the retention windows (w00: concern_outcome 180 days)', () => {
    expect(WISP_CONCERN_RESOLVED_RETENTION_DAYS).toBe(90);
    expect(WISP_CONCERN_OUTCOME_MEMORY_RETENTION_DAYS).toBe(180);
  });

  it('runs the reaper with the 90-day window and the 500-row bound', async () => {
    h.reapConcerns.mockResolvedValueOnce({ deleted: 4, subjectGone: 2 });
    h.memoryDeleteCounts = [3];
    const result = await runWispConcernRetention(NOW);
    expect(h.reapConcerns).toHaveBeenCalledWith(NOW, { resolvedRetentionDays: 90, limit: 500 });
    expect(result).toEqual({ concernsDeleted: 4, subjectGone: 2, memoryBlocksDeleted: 3 });
  });

  it('deletes concern_outcome blocks older than 180 days and nothing else', async () => {
    h.memoryDeleteCounts = [1];
    await runWispConcernRetention(NOW);
    const [del] = memoryDeletes();
    expect(del).toBeDefined();
    // Literal block type: the scan must match W03's partial index predicate,
    // and `fact` (or any other) blocks are never in scope.
    expect(del!.text).toContain("block_type = 'concern_outcome'");
    expect(del!.text).not.toMatch(/'fact'|'preference'|'decision'/);
    expect(del!.text).toMatch(/created_at < \$\d+::timestamptz/);
    const iso = del!.params.find((p) => typeof p === 'string') as string;
    const cutoff = new Date(iso);
    expect(cutoff.getTime()).toBe(NOW.getTime() - 180 * DAY);
    expect(new Date(NOW.getTime() - 181 * DAY) < cutoff).toBe(true);   // deleted
    expect(new Date(NOW.getTime() - 179 * DAY) < cutoff).toBe(false);  // kept
    expect(h.contexts).toContain('wisp.concernRetention.memory');
  });

  it('batches the memory delete at 500 and stops at 20 batches', async () => {
    h.memoryDeleteCounts = Array.from({ length: 25 }, () => 500);
    const result = await runWispConcernRetention(NOW);
    expect(memoryDeletes()).toHaveLength(20);
    expect(memoryDeletes()[0]!.params).toContain(500);
    expect(result.memoryBlocksDeleted).toBe(10_000);
  });

  it('a throwing reaper is logged and the memory pass still runs', async () => {
    h.reapConcerns.mockRejectedValueOnce(new Error('reaper down'));
    h.memoryDeleteCounts = [2];
    const result = await runWispConcernRetention(NOW);
    expect(result).toEqual({ concernsDeleted: 0, subjectGone: 0, memoryBlocksDeleted: 2 });
    expect(h.captureException).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('a throwing memory pass is logged and the reaper counts still come back', async () => {
    h.reapConcerns.mockResolvedValueOnce({ deleted: 1, subjectGone: 1 });
    h.memoryFails = true;
    const result = await runWispConcernRetention(NOW);
    expect(result).toEqual({ concernsDeleted: 1, subjectGone: 1, memoryBlocksDeleted: 0 });
    expect(h.captureException).toHaveBeenCalled();
  });

  it('flag off: zeros, no reaper, no SQL', async () => {
    h.enabled = false;
    const result = await runWispConcernRetention(NOW);
    expect(result).toEqual({ concernsDeleted: 0, subjectGone: 0, memoryBlocksDeleted: 0 });
    expect(h.reapConcerns).not.toHaveBeenCalled();
    expect(h.statements).toHaveLength(0);
  });
});

describe('initializeWispConcernRetention', () => {
  it('removes existing repeatables first, then registers the registry slot', async () => {
    h.getRepeatableJobs.mockImplementation(async () => [{ key: 'old-a' }, { key: 'old-b' }]);
    await initializeWispConcernRetention();
    expect(h.order).toEqual(['remove:old-a', 'remove:old-b', 'add']);
    const [, , opts] = h.add.mock.calls[0] as [string, unknown, { repeat: { pattern: string } }];
    expect(opts.repeat).toEqual({ pattern: jobSchedule('wisp-concern-retention') });
    expect(jobSchedule('wisp-concern-retention')).toBe('23 21 * * *');
  });

  it('the worker processor runs the retention sweep', async () => {
    await initializeWispConcernRetention();
    h.reapConcerns.mockResolvedValueOnce({ deleted: 2, subjectGone: 0 });
    const out = await h.processor.current!({ data: {} });
    expect(out).toEqual({ concernsDeleted: 2, subjectGone: 0, memoryBlocksDeleted: 0 });
  });

  it('shutdown closes the worker and the queue', async () => {
    await initializeWispConcernRetention();
    await shutdownWispConcernRetention();
    expect(h.workerClose).toHaveBeenCalled();
    expect(h.queueClose).toHaveBeenCalled();
  });
});
