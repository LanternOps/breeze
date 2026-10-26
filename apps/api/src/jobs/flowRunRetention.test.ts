import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Tool catalog W04 (#5219), plan Task A8 / Decision 9 — run body pruning.
 * Rows are never deleted: run and step SHELLS stay (intents reference runs
 * ON DELETE RESTRICT), only the bodies go.
 */
const h = vi.hoisted(() => ({
  results: [] as Array<{ runs: number; steps: number }>,
  queries: [] as Array<{ text: string; params: unknown[] }>,
  retentionDays: 90,
}));

const dialect = new PgDialect();

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      h.queries.push({ text: sql.replace(/\s+/g, ' '), params });
      return [h.results.shift() ?? { runs: 0, steps: 0 }];
    }),
  },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../config/env', () => ({ flowRunRetentionDays: () => h.retentionDays }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: vi.fn() }));

import { pruneFlowRunBodies } from './flowRunRetention';

beforeEach(() => {
  vi.clearAllMocks();
  h.results.length = 0;
  h.queries.length = 0;
  h.retentionDays = 90;
});

describe('pruneFlowRunBodies', () => {
  it('prunes bodies only for terminal runs past the window and deletes nothing', async () => {
    h.results.push({ runs: 3, steps: 7 });
    const now = new Date('2026-10-25T00:00:00.000Z');
    const summary = await pruneFlowRunBodies({ now, batchSize: 1000, maxBatches: 50 });
    expect(summary).toMatchObject({ runs: 3, steps: 7, batches: 1, hasMore: false });

    const { text, params } = h.queries[0]!;
    expect(text).not.toMatch(/\bDELETE\b/i);
    expect(text).toContain("status IN ('completed', 'failed', 'cancelled', 'expired')");
    expect(text).toContain('bodies_pruned_at IS NULL');
    expect(text).toMatch(/finished_at < \$\d+::timestamptz/);
    expect(params).toContain(new Date(now.getTime() - 90 * 86_400_000).toISOString());
    expect(text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(text).toContain('SET rendered_input = NULL, output = NULL');
    expect(text).toContain('SET trigger_payload = NULL, inputs = NULL, bodies_pruned_at = now()');
  });

  it('uses FLOW_RUN_RETENTION_DAYS for the window', async () => {
    h.retentionDays = 7;
    const now = new Date('2026-10-25T00:00:00.000Z');
    await pruneFlowRunBodies({ now, batchSize: 1000, maxBatches: 50 });
    expect(h.queries[0]!.params).toContain(new Date(now.getTime() - 7 * 86_400_000).toISOString());
  });

  it('batches of 1,000 until a short batch', async () => {
    h.results.push({ runs: 1000, steps: 4000 }, { runs: 1000, steps: 10 }, { runs: 12, steps: 0 });
    const summary = await pruneFlowRunBodies({ now: new Date(), batchSize: 1000, maxBatches: 50 });
    expect(h.queries).toHaveLength(3);
    expect(h.queries[0]!.params).toContain(1000);
    expect(summary).toMatchObject({ runs: 2012, steps: 4010, batches: 3, hasMore: false });
  });

  it('stops at maxBatches and reports a backlog', async () => {
    h.results.push({ runs: 1000, steps: 0 }, { runs: 1000, steps: 0 });
    const summary = await pruneFlowRunBodies({ now: new Date(), batchSize: 1000, maxBatches: 2 });
    expect(summary).toMatchObject({ batches: 2, hasMore: true });
  });

  it('a missing summary row is an error, never "0 pruned"', async () => {
    const { db } = await import('../db');
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await expect(pruneFlowRunBodies({ now: new Date(), batchSize: 1000, maxBatches: 1 })).rejects.toThrow(/no summary row/);
  });
});
