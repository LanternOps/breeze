import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  executed: [] as unknown[],
  rowCounts: [] as number[],
  recordRetentionRun: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      state.executed.push(query);
      return { count: state.rowCounts.shift() ?? 0 };
    }),
  },
  withSystemDbAccessContext: state.withSystemDbAccessContext,
}));
vi.mock('../db/rowCount', () => ({
  extractRowCount: (r: { count?: number }) => r.count ?? 0,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: state.recordRetentionRun }));

import { pruneM365SyncRetention } from './m365SyncRetentionWorker';

const dialect = new PgDialect();
const compiled = () => state.executed.map((q) => dialect.sqlToQuery(q as SQL));

describe('m365 sync retention sweep', () => {
  beforeEach(() => {
    state.executed.length = 0;
    state.rowCounts.length = 0;
    state.recordRetentionRun.mockClear();
    state.withSystemDbAccessContext.mockClear();
  });

  it('prunes all four entity tables and nulls aged control_scores, under a system DB context', async () => {
    const result = await pruneM365SyncRetention();
    expect(state.withSystemDbAccessContext).toHaveBeenCalledTimes(1);

    const queries = compiled();
    // One statement per entity table (each returns a short batch) + one score prune.
    expect(queries).toHaveLength(5);
    for (const [i, table] of ['m365_users', 'm365_intune_devices', 'm365_ca_policies', 'm365_license_skus'].entries()) {
      expect(queries[i]!.sql).toMatch(new RegExp(`DELETE FROM "${table}"`));
      expect(queries[i]!.sql).toMatch(/WHERE is_stale\s+AND stale_since < now\(\) - make_interval\(days => \$1::int\)/);
      expect(queries[i]!.params).toEqual([30, 10000]);
    }
    expect(queries[4]!.sql).toMatch(/UPDATE m365_secure_score_snapshots\s+SET control_scores = NULL/);
    expect(queries[4]!.sql).toMatch(/score_date < current_date - \$1::int/);
    expect(queries[4]!.params).toEqual([90, 10000]);
    expect(result.deletedEntities).toBe(0);
    expect(result.prunedScoreControls).toBe(0);
  });

  it('keeps batching while a batch comes back full, then stops', async () => {
    // First entity table: one full batch, then a short one. Everything else
    // returns 0 and stops immediately.
    state.rowCounts.push(10000, 7);
    const result = await pruneM365SyncRetention();
    expect(result.deletedEntities).toBe(10007);
    expect(compiled()).toHaveLength(6);
  });

  it('publishes a retention metric under the registered job name', async () => {
    state.rowCounts.push(3);
    await pruneM365SyncRetention();
    expect(state.recordRetentionRun).toHaveBeenCalledWith('m365_sync_retention', { rowsDeleted: 3 });
  });
});
