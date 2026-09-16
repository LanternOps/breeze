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

const bull = vi.hoisted(() => ({
  queueAdd: vi.fn(async () => undefined),
  getRepeatableJobs: vi.fn(async () => [{ key: 'stale-a' }, { key: 'stale-b' }]),
  removeRepeatableByKey: vi.fn(async (_key: string) => true),
  queueClose: vi.fn(async () => undefined),
  workerOn: vi.fn(),
  workerClose: vi.fn(async () => undefined),
  queueNames: [] as string[],
  workerNames: [] as string[],
  attach: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string) { bull.queueNames.push(name); }
    add = bull.queueAdd;
    getRepeatableJobs = bull.getRepeatableJobs;
    removeRepeatableByKey = bull.removeRepeatableByKey;
    close = bull.queueClose;
  },
  Worker: class {
    constructor(name: string) { bull.workerNames.push(name); }
    on = bull.workerOn;
    close = bull.workerClose;
  },
}));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: bull.attach }));

import {
  initializeM365SyncRetention,
  pruneM365SyncRetention,
  shutdownM365SyncRetention,
  SIGNIN_EVENTS_RETENTION_DAYS,
  STALE_ENTITY_TABLES,
} from './m365SyncRetentionWorker';
import { jobSchedule } from './scheduleRegistry';

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
    // One statement per entity table (each returns a short batch) + one score
    // prune + (#5784 W05) one sign-in-event sweep.
    expect(queries).toHaveLength(6);
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
    expect(compiled()).toHaveLength(7);
  });

  it('initialize replaces stale repeatables with ONE daily job at the registry slot, and shutdown closes both', async () => {
    await initializeM365SyncRetention();
    expect(bull.workerNames).toEqual(['m365-sync-retention']);
    expect(bull.queueNames).toEqual(['m365-sync-retention']);
    // Name must match consumers('m365SyncRetention') in workerReadinessManifest.ts.
    expect(bull.attach).toHaveBeenCalledWith(expect.anything(), 'm365SyncRetention');
    // Every previously-registered repeatable is removed before re-adding, so a
    // redeploy never leaves two daily sweeps scheduled.
    expect(bull.removeRepeatableByKey.mock.calls.map((c) => c[0])).toEqual(['stale-a', 'stale-b']);
    expect(bull.queueAdd).toHaveBeenCalledTimes(1);
    expect(bull.queueAdd).toHaveBeenCalledWith(
      'prune',
      {},
      expect.objectContaining({ repeat: { pattern: jobSchedule('m365-sync-retention') } }),
    );
    expect(bull.removeRepeatableByKey.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(bull.queueAdd.mock.invocationCallOrder[0]!);

    await shutdownM365SyncRetention();
    expect(bull.workerClose).toHaveBeenCalledTimes(1);
    expect(bull.queueClose).toHaveBeenCalledTimes(1);
  });

  it('#5784 W05: deletes sign-in events older than 120 days in ctid batches', async () => {
    await pruneM365SyncRetention();
    const stmt = compiled().find((q) => q.sql.includes('m365_signin_events'));
    expect(stmt, 'no m365_signin_events sweep ran').toBeDefined();
    expect(stmt!.sql).toMatch(/DELETE FROM "m365_signin_events"/);
    expect(stmt!.sql).toMatch(/signed_in_at < now\(\) - make_interval\(days => \$1::int\)/);
    expect(stmt!.sql).toMatch(/ctid IN \(/);
    expect(stmt!.params).toEqual([SIGNIN_EVENTS_RETENTION_DAYS, 10000]);
  });

  it('#5784 W05: 120 days — a shorter window would silently clip a quarterly comparison', () => {
    expect(SIGNIN_EVENTS_RETENTION_DAYS).toBe(120);
  });

  it('#5784 W05: the cutoff is strict — an event AT the boundary is kept', async () => {
    await pruneM365SyncRetention();
    const stmt = compiled().find((q) => q.sql.includes('m365_signin_events'))!;
    // `<` not `<=`: a row at exactly 120 days survives. The nearest cases below
    // are two days either side, so only this pins the comparison operator.
    expect(stmt.sql).toMatch(/signed_in_at < now\(\)/);
    expect(stmt.sql).not.toMatch(/signed_in_at <= now\(\)/);
  });

  it('#5784 W05: the sign-in-event sweep keeps batching past a full batch', async () => {
    // Its own for(;;) loop, separate from deleteStaleEntities's — a dropped
    // guard here would stop after 10k rows and leave the rest to accumulate.
    state.rowCounts.push(0, 0, 0, 0, 0, 10000, 3);
    const result = await pruneM365SyncRetention();
    expect(result.deletedSigninEvents).toBe(10003);
    const eventSweeps = compiled().filter((q) => q.sql.includes('m365_signin_events'));
    expect(eventSweeps).toHaveLength(2);
  });

  it('#5784 W05: m365_signin_events is NOT in the stale-entity sweep', () => {
    // It has no is_stale / stale_since columns; the stale sweep would error.
    expect(STALE_ENTITY_TABLES).not.toContain('m365_signin_events');
  });

  it('#5784 W05: purged sign-in events count toward rowsDeleted', async () => {
    state.rowCounts.push(0, 0, 0, 0, 0, 4);   // four entity tables, score prune, then events
    const result = await pruneM365SyncRetention();
    expect(result.deletedSigninEvents).toBe(4);
    expect(state.recordRetentionRun)
      .toHaveBeenCalledWith('m365_sync_retention', { rowsDeleted: 4 });
  });

  it('publishes a retention metric under the registered job name', async () => {
    state.rowCounts.push(3);
    await pruneM365SyncRetention();
    expect(state.recordRetentionRun).toHaveBeenCalledWith('m365_sync_retention', { rowsDeleted: 3 });
  });
});
