import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { executeMock, contextLabels } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  contextLabels: [] as Array<string | undefined>,
}));

vi.mock('../db', () => ({
  db: {
    execute: executeMock,
  },
  runOutsideDbContext: (fn: () => Promise<unknown>) => fn(),
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) => {
    contextLabels.push(label);
    return fn();
  },
}));

import {
  dropExpiredMetricRollupPartitions,
  ensureMetricRollupPartitions,
  metricRollupBucketPartitionName,
  metricRollupPartitionName,
  parseMetricRollupPartitionMonth,
  runMetricRollupMaintenance,
} from './metricRollupMaintenance';
import { normalizeMetricRollupRetentionDays } from './metricRollupRetention';

const dialect = new PgDialect();

function render(statement: unknown): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement as SQL);
  return { text: query.sql, params: query.params };
}

type MonthRow = { partitionName: string; relkind: 'p' | 'r'; leaves: string[] };

/**
 * Routes each statement the maintenance run issues to a canned answer, and
 * records what was called, so a test can assert on the plan rather than on
 * call order.
 */
function installDb(options: {
  months?: MonthRow[];
  lockAcquired?: boolean;
  ensure?: (month: string) => string | null;
  failOn?: (text: string, params: unknown[]) => Error | null;
  /** What the drain probe sees: a pending drain table, and the default's months. */
  drain?: { pending?: boolean; months?: string[]; created?: string[]; batches?: Array<[number | null, number, number]> };
} = {}) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const batches = [...(options.drain?.batches ?? [[null, 0, 0]])];
  executeMock.mockImplementation(async (statement: unknown) => {
    const { text, params } = render(statement);
    calls.push({ text, params });
    const failure = options.failOn?.(text, params);
    if (failure) throw failure;
    if (text.includes('pg_try_advisory_xact_lock')) return [{ acquired: options.lockAcquired ?? true }];
    if (text.includes("set_config('lock_timeout'")) return [];
    if (text.includes('breeze_ensure_metric_rollup_partition')) {
      const month = String(params[0]);
      return [{ partitionName: options.ensure ? options.ensure(month) : `ensured:${month}` }];
    }
    if (text.includes('FROM pg_inherits')) return options.months ?? [];
    if (text.includes('breeze_drop_metric_rollup_bucket_partition')) {
      const month = parseMetricRollupPartitionMonth(`metric_rollups_y${String(params[0]).slice(0, 4)}m${String(params[0]).slice(5, 7)}`)!;
      return [{ partitionName: metricRollupBucketPartitionName(month, params[1] as 300 | 3600) }];
    }
    if (text.includes('breeze_drop_metric_rollup_partition')) {
      return [{ partitionName: `metric_rollups_y${String(params[0]).slice(0, 4)}m${String(params[0]).slice(5, 7)}` }];
    }
    if (text.includes('breeze_prepare_metric_rollup_compaction') || text.includes('breeze_compact_metric_rollup_partition')) {
      return [{ partitionName: `metric_rollups_y${String(params[0]).slice(0, 4)}m${String(params[0]).slice(5, 7)}` }];
    }
    if (text.includes('breeze_metric_rollup_default_drain_exists')) {
      return [{ pending: options.drain?.pending ?? false, months: options.drain?.months ?? [] }];
    }
    if (text.includes('breeze_swap_metric_rollup_default')) return [{ created: options.drain?.created ?? [] }];
    if (text.includes('breeze_drain_metric_rollup_default_batch')) {
      const [nextPage, moved, discarded] = batches.shift() ?? [null, 0, 0];
      return [{ nextPage, moved: String(moved), discarded: String(discarded) }];
    }
    if (text.includes('breeze_finish_metric_rollup_default_drain')) return [{ dropped: true }];
    throw new Error(`unexpected statement: ${text}`);
  });
  return calls;
}

function named(calls: Array<{ text: string; params: unknown[] }>, fn: string) {
  return calls.filter((call) => call.text.includes(fn));
}

// now = 2026-09-29 with the default windows 90 / 548 / 1095 days gives cutoffs
// 5m 2026-07-01, hourly 2025-03-30, daily 2023-10-02.
const NOW = new Date('2026-09-29T00:00:00.000Z');

describe('metric rollup maintenance service', () => {
  beforeEach(() => {
    executeMock.mockReset();
    contextLabels.length = 0;
  });

  it('uses deterministic month and bucket-leaf partition names', () => {
    expect(metricRollupPartitionName(new Date('2026-06-18T12:00:00.000Z'))).toBe('metric_rollups_y2026m06');
    expect(metricRollupBucketPartitionName(new Date('2026-06-01T00:00:00.000Z'), 300)).toBe('metric_rollups_y2026m06_5m');
    expect(metricRollupBucketPartitionName(new Date('2026-06-01T00:00:00.000Z'), 3600)).toBe('metric_rollups_y2026m06_1h');
    expect(metricRollupBucketPartitionName(new Date('2026-06-01T00:00:00.000Z'), 86400)).toBe('metric_rollups_y2026m06_1d');
    expect(parseMetricRollupPartitionMonth('metric_rollups_y2026m06')?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(parseMetricRollupPartitionMonth('metric_rollups_y2026m06_5m')).toBeNull();
    expect(parseMetricRollupPartitionMonth('metric_rollups_default')).toBeNull();
  });

  describe('retention windows', () => {
    it('applies the floors', () => {
      expect(normalizeMetricRollupRetentionDays({ fiveMinute: 1, hourly: 1, daily: 1 })).toEqual({
        fiveMinute: 30,
        hourly: 365,
        daily: 730,
      });
    });

    it('keeps the windows monotonic so a coarser bucket never expires before a finer one', () => {
      // hourly buckets are derived from 5-minute rows and a whole month drops at
      // the daily cutoff, so a longer finer window must pull the coarser up.
      expect(normalizeMetricRollupRetentionDays({ fiveMinute: 400, hourly: 365, daily: 730 })).toEqual({
        fiveMinute: 400,
        hourly: 400,
        daily: 730,
      });
      expect(normalizeMetricRollupRetentionDays({ fiveMinute: 90, hourly: 900, daily: 800 })).toEqual({
        fiveMinute: 90,
        hourly: 900,
        daily: 900,
      });
    });
  });

  it('ensures monthly partitions through the SECURITY DEFINER function, one call per month', async () => {
    const calls = installDb({ ensure: (month) => `metric_rollups_y${month.slice(0, 4)}m${month.slice(5, 7)}` });

    const ensured = await ensureMetricRollupPartitions({
      referenceDate: new Date('2026-06-18T12:00:00.000Z'),
      monthsBack: 0,
      monthsAhead: 1,
    });

    expect(ensured).toEqual(['metric_rollups_y2026m06', 'metric_rollups_y2026m07']);
    expect(calls).toHaveLength(2);
    const executedSql = JSON.stringify(calls);
    expect(executedSql).toContain('public.breeze_ensure_metric_rollup_partition');
    expect(executedSql).toContain('2026-06-01 00:00:00');
    expect(executedSql).toContain('2026-07-01 00:00:00');
    // The DDL must NOT be issued from the app connection (BREEZE-10).
    expect(executedSql).not.toContain('PARTITION OF metric_rollups');
    expect(executedSql).not.toContain('ENABLE ROW LEVEL SECURITY');
    expect(executedSql).not.toContain('CREATE POLICY');
  });

  it('treats a NULL partition name as a default-partition overlap skip', async () => {
    installDb({ ensure: (month) => (month.startsWith('2026-06') ? null : 'metric_rollups_y2026m07') });

    const ensured = await ensureMetricRollupPartitions({
      referenceDate: new Date('2026-06-18T12:00:00.000Z'),
      monthsBack: 0,
      monthsAhead: 1,
    });

    expect(ensured).toEqual(['metric_rollups_y2026m07']);
  });

  it('throws rather than silently skipping when the maintenance function is missing', async () => {
    executeMock.mockResolvedValueOnce([]);

    await expect(
      ensureMetricRollupPartitions({
        referenceDate: new Date('2026-06-18T12:00:00.000Z'),
        monthsBack: 0,
        monthsAhead: 0,
      }),
    ).rejects.toThrow(/partitionName column/);
  });

  it('drops only whole months past the daily retention window, through the month-taking seam', async () => {
    const calls = installDb({
      months: [
        { partitionName: 'metric_rollups_y2022m12', relkind: 'r', leaves: [] },
        { partitionName: 'metric_rollups_y2026m06', relkind: 'p', leaves: [] },
      ],
    });

    const dropped = await dropExpiredMetricRollupPartitions(new Date('2026-06-18T12:00:00.000Z'));

    expect(dropped).toEqual(['metric_rollups_y2022m12']);
    const drops = named(calls, 'breeze_drop_metric_rollup_partition');
    expect(drops).toHaveLength(1);
    expect(drops[0]!.params[0]).toBe('2022-12-01 00:00:00');
    expect(JSON.stringify(drops)).not.toContain('DROP TABLE');
  });

  describe('runMetricRollupMaintenance', () => {
    it('drops expired bucket leaves per tier and never issues a row DELETE against a month', async () => {
      const calls = installDb({
        months: [
          // Past the 5m cutoff only: drop _5m, keep _1h/_1d.
          {
            partitionName: 'metric_rollups_y2026m05',
            relkind: 'p',
            leaves: ['metric_rollups_y2026m05_1d', 'metric_rollups_y2026m05_1h', 'metric_rollups_y2026m05_5m'],
          },
          // Past the hourly cutoff too; the _5m leaf is already gone.
          {
            partitionName: 'metric_rollups_y2024m12',
            relkind: 'p',
            leaves: ['metric_rollups_y2024m12_1d', 'metric_rollups_y2024m12_1h'],
          },
          // Inside every window.
          {
            partitionName: 'metric_rollups_y2026m09',
            relkind: 'p',
            leaves: ['metric_rollups_y2026m09_1d', 'metric_rollups_y2026m09_1h', 'metric_rollups_y2026m09_5m'],
          },
          // Past the daily cutoff: the whole month goes.
          { partitionName: 'metric_rollups_y2023m01', relkind: 'p', leaves: ['metric_rollups_y2023m01_1d'] },
        ],
      });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toEqual([]);
      expect(result.droppedBucketPartitions).toEqual(['metric_rollups_y2026m05_5m', 'metric_rollups_y2024m12_1h']);
      expect(result.droppedPartitions).toEqual(['metric_rollups_y2023m01']);
      expect(result.compactedPartitions).toEqual([]);
      const bucketDrops = named(calls, 'breeze_drop_metric_rollup_bucket_partition');
      expect(bucketDrops.map((call) => call.params)).toEqual([
        ['2026-05-01 00:00:00', 300],
        ['2024-12-01 00:00:00', 3600],
      ]);
      // Retention is partition-level only: no row DELETE anywhere, not even
      // against metric_rollups_default (#7541 drains it instead).
      expect(calls.filter((c) => /\bDELETE\b/.test(c.text))).toEqual([]);
    });

    it('runs every step in its own labeled system context with a bounded lock wait and the run lock', async () => {
      installDb({
        months: [
          {
            partitionName: 'metric_rollups_y2026m05',
            relkind: 'p',
            leaves: ['metric_rollups_y2026m05_1d', 'metric_rollups_y2026m05_1h', 'metric_rollups_y2026m05_5m'],
          },
        ],
      });

      await runMetricRollupMaintenance({ now: NOW });

      expect(contextLabels).toEqual([
        'metricRollupMaintenance.drainProbe',
        'metricRollupMaintenance.ensure',
        'metricRollupMaintenance.list',
        'metricRollupMaintenance.dropBucket',
      ]);
      const texts = executeMock.mock.calls.map((call) => render(call[0]).text);
      expect(texts.filter((t) => t.includes("set_config('lock_timeout'"))).toHaveLength(contextLabels.length);
      expect(texts.filter((t) => t.includes('pg_try_advisory_xact_lock'))).toHaveLength(contextLabels.length);
    });

    it('prepares then compacts a legacy flat month once its 5-minute rows expire, keeping hourly while in retention', async () => {
      const calls = installDb({
        months: [
          { partitionName: 'metric_rollups_y2026m05', relkind: 'r', leaves: [] },
          { partitionName: 'metric_rollups_y2024m12', relkind: 'r', leaves: [] },
          // Flat but 5m still in retention: left alone.
          { partitionName: 'metric_rollups_y2026m08', relkind: 'r', leaves: [] },
        ],
      });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.compactedPartitions).toEqual(['metric_rollups_y2026m05', 'metric_rollups_y2024m12']);
      expect(named(calls, 'breeze_prepare_metric_rollup_compaction').map((c) => c.params)).toEqual([
        ['2026-05-01 00:00:00', true],
        ['2024-12-01 00:00:00', false],
      ]);
      expect(named(calls, 'breeze_compact_metric_rollup_partition').map((c) => c.params)).toEqual([
        ['2026-05-01 00:00:00', true],
        ['2024-12-01 00:00:00', false],
      ]);
      // Prepare and compact are separate transactions: the staged leaves' FK
      // lock on devices/organizations must be released before the long copy.
      const prepareIdx = contextLabels.indexOf('metricRollupMaintenance.prepareCompaction');
      expect(contextLabels[prepareIdx + 1]).toBe('metricRollupMaintenance.compact');
    });

    it('records a failed step and still runs the rest of the retention', async () => {
      installDb({
        months: [
          {
            partitionName: 'metric_rollups_y2026m04',
            relkind: 'p',
            leaves: ['metric_rollups_y2026m04_1d', 'metric_rollups_y2026m04_1h', 'metric_rollups_y2026m04_5m'],
          },
          {
            partitionName: 'metric_rollups_y2026m05',
            relkind: 'p',
            leaves: ['metric_rollups_y2026m05_1d', 'metric_rollups_y2026m05_1h', 'metric_rollups_y2026m05_5m'],
          },
        ],
        failOn: (text, params) =>
          text.includes('breeze_drop_metric_rollup_bucket_partition') && params[0] === '2026-04-01 00:00:00'
            ? new Error('canceling statement due to lock timeout')
            : null,
      });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toEqual([
        { step: 'drop-bucket', partition: 'metric_rollups_y2026m04_5m', error: 'canceling statement due to lock timeout' },
      ]);
      expect(result.droppedBucketPartitions).toEqual(['metric_rollups_y2026m05_5m']);
    });

    it('drains a non-empty default before ensure: swap, page batches until done, then finish (#7541)', async () => {
      const calls = installDb({
        months: [],
        drain: {
          months: ['2019-07-01 00:00:00', '2026-10-01 00:00:00'],
          created: ['metric_rollups_y2026m10'],
          batches: [
            [4, 10, 2],
            [8, 5, 0],
            [null, 1, 3],
          ],
        },
      });

      const result = await runMetricRollupMaintenance({ now: NOW, defaultDrainPagesPerBatch: 4 });

      expect(result.failures).toEqual([]);
      expect(result.defaultPartitionDrain).toEqual({
        blockedMonths: ['metric_rollups_y2019m07', 'metric_rollups_y2026m10'],
        resumed: false,
        swapped: true,
        monthsCreated: ['metric_rollups_y2026m10'],
        rowsMoved: 16,
        rowsDiscarded: 5,
        completed: true,
      });
      expect(result.defaultPartitionRowsDeleted).toBe(5);
      // The swap gets the probed months and the daily cutoff; it never scans.
      const literal = (iso: string) => iso.slice(0, 19).replace('T', ' ');
      const cut = {
        fiveMinute: literal(result.cutoffs.fiveMinute),
        hourly: literal(result.cutoffs.hourly),
        daily: literal(result.cutoffs.daily),
      };
      expect(named(calls, 'breeze_swap_metric_rollup_default').map((c) => c.params)).toEqual([
        ['{"2019-07-01 00:00:00","2026-10-01 00:00:00"}', cut.daily],
      ]);
      // Page ranges advance; every batch carries the three retention cutoffs.
      expect(named(calls, 'breeze_drain_metric_rollup_default_batch').map((c) => c.params)).toEqual([
        [0, 4, cut.fiveMinute, cut.hourly, cut.daily],
        [4, 4, cut.fiveMinute, cut.hourly, cut.daily],
        [8, 4, cut.fiveMinute, cut.hourly, cut.daily],
      ]);
      // Each drain step is its own short transaction, all before ensure.
      expect(contextLabels.slice(0, 7)).toEqual([
        'metricRollupMaintenance.drainProbe',
        'metricRollupMaintenance.drainSwap',
        'metricRollupMaintenance.drainBatch',
        'metricRollupMaintenance.drainBatch',
        'metricRollupMaintenance.drainBatch',
        'metricRollupMaintenance.drainFinish',
        'metricRollupMaintenance.ensure',
      ]);
    });

    it('resumes a pending drain without swapping again', async () => {
      const calls = installDb({ months: [], drain: { pending: true, months: [], batches: [[null, 3, 0]] } });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toEqual([]);
      expect(result.defaultPartitionDrain).toMatchObject({ resumed: true, swapped: false, rowsMoved: 3, completed: true });
      expect(named(calls, 'breeze_swap_metric_rollup_default')).toHaveLength(0);
      expect(named(calls, 'breeze_finish_metric_rollup_default_drain')).toHaveLength(1);
    });

    it('does nothing to the default when it is empty', async () => {
      const calls = installDb({ months: [] });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.defaultPartitionDrain).toMatchObject({ blockedMonths: [], swapped: false, completed: true });
      expect(named(calls, 'breeze_swap_metric_rollup_default')).toHaveLength(0);
      expect(named(calls, 'breeze_drain_metric_rollup_default_batch')).toHaveLength(0);
      expect(named(calls, 'breeze_finish_metric_rollup_default_drain')).toHaveLength(0);
    });

    it('records a failed drain move, never finishes it, and still runs retention', async () => {
      const calls = installDb({
        months: [
          {
            partitionName: 'metric_rollups_y2026m05',
            relkind: 'p',
            leaves: ['metric_rollups_y2026m05_1d', 'metric_rollups_y2026m05_1h', 'metric_rollups_y2026m05_5m'],
          },
        ],
        drain: { months: ['2026-10-01 00:00:00'] },
        failOn: (text) =>
          text.includes('breeze_drain_metric_rollup_default_batch') ? new Error('canceling statement due to lock timeout') : null,
      });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toEqual([
        { step: 'drain-default-move', partition: 'metric_rollups_default', error: 'canceling statement due to lock timeout' },
      ]);
      expect(result.defaultPartitionDrain).toMatchObject({ swapped: true, completed: false });
      expect(named(calls, 'breeze_finish_metric_rollup_default_drain')).toHaveLength(0);
      expect(result.droppedBucketPartitions).toEqual(['metric_rollups_y2026m05_5m']);
    });

    it('records a failed swap, moves nothing, and still runs ensure and retention', async () => {
      const calls = installDb({
        months: [],
        drain: { months: ['2026-10-01 00:00:00'] },
        failOn: (text) =>
          text.includes('breeze_swap_metric_rollup_default') ? new Error('canceling statement due to lock timeout') : null,
      });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toEqual([
        { step: 'drain-default-swap', partition: 'metric_rollups_default', error: 'canceling statement due to lock timeout' },
      ]);
      expect(result.defaultPartitionDrain).toMatchObject({ swapped: false, completed: false, blockedMonths: ['metric_rollups_y2026m10'] });
      expect(named(calls, 'breeze_drain_metric_rollup_default_batch')).toHaveLength(0);
      expect(named(calls, 'breeze_ensure_metric_rollup_partition').length).toBeGreaterThan(0);
    });

    it('records a lock lost after the probe as a failure and never finishes the drain', async () => {
      const calls = installDb({ months: [], drain: { months: ['2026-10-01 00:00:00'] } });
      const base = executeMock.getMockImplementation()!;
      let lockCalls = 0;
      executeMock.mockImplementation(async (statement: unknown) => {
        // Probe gets the lock; the swap step finds it held by another run.
        if (render(statement).text.includes('pg_try_advisory_xact_lock') && ++lockCalls === 2) {
          calls.push(render(statement));
          return [{ acquired: false }];
        }
        return base(statement);
      });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toContainEqual({
        step: 'drain-default-swap',
        partition: 'metric_rollups_default',
        error: 'maintenance lock held by another run',
      });
      expect(named(calls, 'breeze_swap_metric_rollup_default')).toHaveLength(0);
      expect(named(calls, 'breeze_finish_metric_rollup_default_drain')).toHaveLength(0);
    });

    it('fails the drain rather than looping when a batch does not advance', async () => {
      installDb({ months: [], drain: { months: ['2026-10-01 00:00:00'], batches: [[0, 0, 0]] } });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toEqual([
        { step: 'drain-default-move', partition: 'metric_rollups_default', error: 'drain batch did not advance past page 0' },
      ]);
    });

    it('reports a month the default partition blocks as a failure, not a clean run', async () => {
      installDb({ months: [], ensure: (month) => (month.startsWith('2026-10') ? null : `m:${month}`) });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result.failures).toEqual([
        {
          step: 'ensure',
          partition: 'metric_rollups_y2026m10',
          error: 'metric_rollups_default already holds rows for this month, so its partition cannot be created',
        },
      ]);
    });

    it('does not compact a month that prepare no longer finds flat', async () => {
      const calls = installDb({ months: [{ partitionName: 'metric_rollups_y2026m05', relkind: 'r', leaves: [] }] });
      const base = executeMock.getMockImplementation()!;
      executeMock.mockImplementation(async (statement: unknown) => {
        if (render(statement).text.includes('breeze_prepare_metric_rollup_compaction')) {
          calls.push(render(statement));
          return [{ partitionName: null }];
        }
        return base(statement);
      });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(named(calls, 'breeze_compact_metric_rollup_partition')).toHaveLength(0);
      expect(result.compactedPartitions).toEqual([]);
      expect(result.failures).toEqual([]);
    });

    it('skips the whole run when another run holds the maintenance lock', async () => {
      const calls = installDb({ lockAcquired: false });

      const result = await runMetricRollupMaintenance({ now: NOW });

      expect(result).toMatchObject({
        skipped: true,
        reason: 'maintenance lock already held',
        ensuredPartitions: [],
        droppedPartitions: [],
        droppedBucketPartitions: [],
        compactedPartitions: [],
      });
      expect(named(calls, 'breeze_ensure_metric_rollup_partition')).toHaveLength(0);
      expect(named(calls, 'breeze_swap_metric_rollup_default')).toHaveLength(0);
    });
  });
});
