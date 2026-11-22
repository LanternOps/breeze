import { sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { pgErrorCode, pgErrorNode } from '../utils/pgErrors';
import {
  METRIC_ROLLUP_BUCKET_RETENTION_DAYS,
  metricRollupRetentionCutoffs,
  monthStartUtc,
  normalizeMetricRollupRetentionDays,
  type MetricRollupRetentionDays,
} from './metricRollupRetention';

/**
 * `metric_rollups` retention (#7531).
 *
 * Each monthly partition is sub-partitioned by bucket size:
 *
 *   metric_rollups_yYYYYmMM        LIST (bucket_seconds)
 *   ├─ metric_rollups_yYYYYmMM_5m  300
 *   ├─ metric_rollups_yYYYYmMM_1h  3600
 *   └─ metric_rollups_yYYYYmMM_1d  86400
 *
 * so every bucket's retention is a DROP of its leaf once the whole month is
 * past that bucket's cutoff, and the whole month is dropped past the daily
 * cutoff. A DROP returns the files to the OS; the row DELETE this replaced only
 * left dead space in old months that new writes never reuse, which is how the
 * table grew ~8 GB/month per 100 agents without ever shrinking.
 *
 * Months created before #7531 are FLAT (every bucket in one table). Once such
 * a month's 5-minute rows are past retention it is compacted: rewritten into
 * the per-bucket shape with only the retained buckets, and the flat table
 * dropped. See migration 2026-11-10-130000-metric-rollups-bucket-partitions.sql
 * for the SQL side and its lock profile.
 *
 * Every structural step runs in its OWN short system transaction, never one
 * transaction for the whole run: a partition DROP holds ACCESS EXCLUSIVE on
 * its parent until commit, so batching steps would block every reader of
 * metric_rollups for the whole run. Each step bounds its lock waits
 * (`lock_timeout`) and takes a transaction-scoped advisory lock so two runs
 * never interleave.
 */

export { METRIC_ROLLUP_BUCKET_RETENTION_DAYS };

/** Unused since #7541; kept because the job still stamps it into its stored data. */
export const DEFAULT_METRIC_ROLLUP_DELETE_BATCH_SIZE = Math.max(
  100,
  parsePositiveIntEnv('METRIC_ROLLUP_DELETE_BATCH_SIZE', 5000),
);
export const DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_BACK = Math.max(
  0,
  parsePositiveIntEnv('METRIC_ROLLUP_PARTITION_MONTHS_BACK', 0),
);
export const DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_AHEAD = Math.max(
  1,
  parsePositiveIntEnv('METRIC_ROLLUP_PARTITION_MONTHS_AHEAD', 3),
);

/** Drain-table pages moved per short transaction (8 KB pages; ~1 MB, a few
 * thousand rollup rows). Each batch is its own transaction, so this bounds how
 * long any one move holds its row locks, not how much is moved per run. */
export const DEFAULT_METRIC_ROLLUP_DEFAULT_DRAIN_PAGES_PER_BATCH = 128;

/** Bound on every lock wait in a maintenance step (ms). A step that cannot get
 * its locks in time rolls back and is retried on the next daily run, instead
 * of queueing every reader of metric_rollups/devices behind it. */
const MAINTENANCE_LOCK_TIMEOUT_MS = 5000;
const MAINTENANCE_ADVISORY_LOCK = 'metric_rollup_maintenance';

/**
 * Waits between one legacy month's compaction attempts when it cannot get its
 * locks (#10960), so its attempts = this length + 1. Long enough to sample a
 * different moment of traffic, not the same busy second. The budget is per
 * month, and spans prepare and compact. No transaction is open during a wait.
 */
const COMPACTION_RETRY_BACKOFF_MS: readonly number[] = [60_000, 180_000];

/**
 * Total time one run may spend in those waits, across every month. Each month
 * keeps its own attempts, but a backlog of contended months must not stretch
 * the nightly run (and a worker shutdown waiting on it) by 4 minutes a month.
 * Once it is spent, a contended month defers after the attempt it is on.
 */
const COMPACTION_RETRY_SLEEP_BUDGET_MS = 15 * 60_000;

/**
 * A month this many days past the day it came due for compaction, and still
 * contended, has stalled: the run reports it as a failure. Short of this a
 * contended month is routine and just retries on the next nightly run.
 */
const COMPACTION_STALL_AFTER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const PG_LOCK_NOT_AVAILABLE = '55P03';

type RetainedBucketSeconds = 300 | 3600;
const BUCKET_LEAF_SUFFIX: Record<300 | 3600 | 86400, string> = { 300: '5m', 3600: '1h', 86400: '1d' };

type EnsurePartitionOptions = {
  referenceDate?: Date;
  monthsBack?: number;
  monthsAhead?: number;
  /** Called for each month skipped because metric_rollups_default holds rows for it. */
  onSkipped?: (partitionName: string) => void;
};

export type MetricRollupMonthPartition = {
  name: string;
  monthStart: Date;
  /** `bucketed` = per-bucket leaves (#7531); `flat` = legacy single table. */
  shape: 'bucketed' | 'flat';
  /** Attached leaf names, bucketed months only. */
  leaves: string[];
};

export type MetricRollupMaintenanceFailure = {
  step: string;
  partition: string;
  error: string;
};

/** A legacy month left uncompacted because it could not get its locks (#10960). */
export type MetricRollupDeferredCompaction = {
  partition: string;
  /** The step whose locks ran out on the last attempt. */
  step: 'prepare-compaction' | 'compact';
  attempts: number;
  /** Whole days since the month's 5-minute rows expired and it came due. */
  overdueDays: number;
  /** Past COMPACTION_STALL_AFTER_DAYS; the month is in `failures` too. */
  stalled: boolean;
  error: string;
};

export type MetricRollupDefaultDrainResult = {
  /** Months metric_rollups_default held rows for when the run started. Non-empty
   * means some month had no partition when its rows were written. */
  blockedMonths: string[];
  /** A drain left by an earlier run was found and resumed (no new swap). */
  resumed: boolean;
  /** The default was detached and replaced this run. */
  swapped: boolean;
  /** Month partitions the swap created for the blocked months. */
  monthsCreated: string[];
  /** Rows re-inserted through metric_rollups into their partitions. */
  rowsMoved: number;
  /** Expired rows the drain did not re-insert. */
  rowsDiscarded: number;
  /** No drain table is left behind (nothing to drain, or fully drained and dropped). */
  completed: boolean;
};

export type MetricRollupMaintenanceResult = {
  ensuredPartitions: string[];
  /** Whole months dropped at the daily cutoff. */
  droppedPartitions: string[];
  /** Bucket leaves dropped at the 5-minute / hourly cutoff. */
  droppedBucketPartitions: string[];
  /** Legacy flat months rewritten into per-bucket leaves. */
  compactedPartitions: string[];
  /** Expired rows removed from metric_rollups_default by the drain. */
  defaultPartitionRowsDeleted: number;
  /** The metric_rollups_default drain (#7541). */
  defaultPartitionDrain: MetricRollupDefaultDrainResult;
  retentionDays: MetricRollupRetentionDays;
  cutoffs: { fiveMinute: string; hourly: string; daily: string };
  /** Steps that failed; the rest of the run still completed. */
  failures: MetricRollupMaintenanceFailure[];
  /** Legacy months still uncompacted because their locks were never free. */
  deferredCompactions: MetricRollupDeferredCompaction[];
  durationMs: number;
  skipped?: boolean;
  reason?: string;
};

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[MetricRollupMaintenance] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${name} must be a valid Date`);
  }
}

function addMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function formatTimestampLiteral(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the single `partitionName` column returned by the partition-maintenance
 * SECURITY DEFINER functions. A SQL NULL is a meaningful answer ("skipped" /
 * "nothing attached"), so it is returned as null — but a missing row or a
 * missing column is NOT: that means the function is absent or changed shape,
 * and silently treating it as a skip would turn a broken deployment into an
 * invisible no-op, which is precisely how BREEZE-10 stayed hidden.
 */
function readPartitionNameResult(result: unknown, context: string): string | null {
  const row = Array.isArray(result) ? (result[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || !('partitionName' in row)) {
    throw new Error(
      `[MetricRollupMaintenance] ${context} returned no partitionName column — expected the metric_rollups partition functions (migrations 2026-08-05 and 2026-11-10-130000) to exist`,
    );
  }
  const value = row.partitionName;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`[MetricRollupMaintenance] ${context} returned a non-string partitionName: ${typeof value}`);
  }
  return value;
}

export function metricRollupPartitionName(monthStart: Date): string {
  assertValidDate(monthStart, 'monthStart');
  return `metric_rollups_y${monthStart.getUTCFullYear()}m${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function metricRollupBucketPartitionName(monthStart: Date, bucketSeconds: 300 | 3600 | 86400): string {
  return `${metricRollupPartitionName(monthStart)}_${BUCKET_LEAF_SUFFIX[bucketSeconds]}`;
}

export function parseMetricRollupPartitionMonth(partitionName: string): Date | null {
  const match = /^metric_rollups_y(\d{4})m(\d{2})$/.exec(partitionName);
  if (!match) return null;
  const [, yearRaw, monthRaw] = match;
  if (!yearRaw || !monthRaw) return null;
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Marker for a step that found another maintenance run holding the lock. */
const LOCK_HELD = Symbol('metric-rollup-maintenance-lock-held');

/**
 * Run one maintenance step in its own short system transaction, with bounded
 * lock waits and the run's advisory lock. `runOutsideDbContext` makes sure a
 * caller's ambient context can never fold the steps back into one long
 * transaction (the #3216 / #4276 trap).
 */
function inMaintenanceStep<T>(label: string, fn: () => Promise<T>): Promise<T | typeof LOCK_HELD> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT set_config('lock_timeout', ${`${MAINTENANCE_LOCK_TIMEOUT_MS}ms`}, true)`);
      const result = await db.execute(sql`
        SELECT pg_try_advisory_xact_lock(hashtext(${MAINTENANCE_ADVISORY_LOCK})) AS "acquired"
      `);
      const row = Array.isArray(result) ? (result[0] as { acquired?: unknown } | undefined) : undefined;
      if (row?.acquired !== true) return LOCK_HELD;
      return fn();
    }, `metricRollupMaintenance.${label}`),
  );
}

/**
 * Ensure the monthly partitions around `referenceDate` exist. Runs in the
 * CALLER's DB context (the integration suite wraps it in a system context);
 * the maintenance run calls it inside its own step.
 */
export async function ensureMetricRollupPartitions(options: EnsurePartitionOptions = {}): Promise<string[]> {
  const referenceDate = options.referenceDate ?? new Date();
  assertValidDate(referenceDate, 'referenceDate');

  const monthsBack = Math.max(0, options.monthsBack ?? DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_BACK);
  const monthsAhead = Math.max(1, options.monthsAhead ?? DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_AHEAD);
  const anchor = monthStartUtc(referenceDate);
  const ensured: string[] = [];

  for (let offset = -monthsBack; offset <= monthsAhead; offset += 1) {
    const from = addMonths(anchor, offset);
    const partitionName = metricRollupPartitionName(from);

    // The DDL lives in a SECURITY DEFINER function owned by the migration role:
    // breeze_app has no CREATE on schema public and owns neither metric_rollups
    // nor its children (BREEZE-10). The function takes the month and derives
    // every name itself, so no identifier crosses the boundary. It creates new
    // months in the per-bucket shape and converts empty legacy flat ones.
    const result = await db.execute(sql`
      SELECT public.breeze_ensure_metric_rollup_partition(
        ${formatTimestampLiteral(from)}::timestamp
      ) AS "partitionName"
    `);

    // NULL means the function skipped the month because metric_rollups_default
    // already holds rows for it.
    const ensuredName = readPartitionNameResult(result, `ensure ${partitionName}`);
    if (ensuredName === null) {
      console.warn(
        `[MetricRollupMaintenance] Skipping ${partitionName}; metric_rollups_default already contains rows for that month`,
      );
      options.onSkipped?.(partitionName);
      continue;
    }
    ensured.push(ensuredName);
  }

  return ensured;
}

/** Every attached monthly partition, its shape and its leaves. */
export async function listMetricRollupMonthPartitions(): Promise<MetricRollupMonthPartition[]> {
  const result = await db.execute(sql`
    SELECT
      child.relname AS "partitionName",
      child.relkind::text AS "relkind",
      coalesce(
        (
          SELECT array_agg(leaf.relname::text ORDER BY leaf.relname)
          FROM pg_inherits leaf_inh
          JOIN pg_class leaf ON leaf.oid = leaf_inh.inhrelid
          WHERE leaf_inh.inhparent = child.oid
        ),
        ARRAY[]::text[]
      ) AS "leaves"
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE parent.relname = 'metric_rollups'
      AND parent_ns.nspname = 'public'
      AND child_ns.nspname = 'public'
      AND child.relname ~ '^metric_rollups_y[0-9]{4}m[0-9]{2}$'
    ORDER BY child.relname
  `);

  const partitions: MetricRollupMonthPartition[] = [];
  for (const raw of Array.isArray(result) ? result : []) {
    const row = raw as { partitionName?: unknown; relkind?: unknown; leaves?: unknown };
    if (typeof row.partitionName !== 'string') continue;
    const monthStart = parseMetricRollupPartitionMonth(row.partitionName);
    if (!monthStart) continue;
    partitions.push({
      name: row.partitionName,
      monthStart,
      shape: row.relkind === 'p' ? 'bucketed' : 'flat',
      leaves: Array.isArray(row.leaves) ? row.leaves.filter((leaf): leaf is string => typeof leaf === 'string') : [],
    });
  }
  return partitions;
}

/** Names only; kept for callers that predate the per-bucket shape. */
export async function listMetricRollupPartitions(): Promise<string[]> {
  return (await listMetricRollupMonthPartitions()).map((partition) => partition.name);
}

async function dropMonthPartition(monthStart: Date, context: string): Promise<string | null> {
  // DROP TABLE is owner-only DDL, so it goes through the SECURITY DEFINER seam.
  // Passing the month (not a discovered name) means the function re-derives and
  // re-verifies attachment before dropping — metric_rollups_default is
  // unreachable by construction.
  const result = await db.execute(sql`
    SELECT public.breeze_drop_metric_rollup_partition(
      ${formatTimestampLiteral(monthStart)}::timestamp
    ) AS "partitionName"
  `);
  return readPartitionNameResult(result, context);
}

async function dropBucketPartition(
  monthStart: Date,
  bucketSeconds: RetainedBucketSeconds,
  context: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT public.breeze_drop_metric_rollup_bucket_partition(
      ${formatTimestampLiteral(monthStart)}::timestamp,
      ${bucketSeconds}::integer
    ) AS "partitionName"
  `);
  return readPartitionNameResult(result, context);
}

/**
 * Drop every whole month past the daily cutoff. Runs in the CALLER's DB
 * context; kept as a standalone helper for the integration suite.
 */
export async function dropExpiredMetricRollupPartitions(
  now = new Date(),
  retention: MetricRollupRetentionDays = METRIC_ROLLUP_BUCKET_RETENTION_DAYS,
): Promise<string[]> {
  assertValidDate(now, 'now');
  const dailyCutoff = metricRollupRetentionCutoffs(now, retention).daily;
  const dropped: string[] = [];
  for (const partition of await listMetricRollupMonthPartitions()) {
    if (addMonths(partition.monthStart, 1).getTime() > dailyCutoff.getTime()) continue;
    const droppedName = await dropMonthPartition(partition.monthStart, `drop ${partition.name}`);
    if (droppedName !== null) dropped.push(droppedName);
  }
  return dropped;
}

function readRow(result: unknown): Record<string, unknown> {
  const row = Array.isArray(result) ? (result[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) throw new Error('[MetricRollupMaintenance] expected one row, got none');
  return row;
}

function readCount(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' || typeof value === 'bigint' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`[MetricRollupMaintenance] ${name} is not a number: ${String(value)}`);
  }
  return parsed;
}

/**
 * Drain metric_rollups_default (#7541).
 *
 * A row lands in the default only when its month had no partition when it was
 * written, and from then on that month cannot be created (CREATE ... PARTITION
 * OF would have to move the row). Its writes keep landing in the default,
 * where retention is a row DELETE whose space is never returned, and every
 * month creation scans the whole default under ACCESS EXCLUSIVE.
 *
 * So instead of deleting inside it, the run swaps the default out — detach it
 * into metric_rollups_staging, attach a fresh empty one and create the blocked
 * months, all in one short bounded transaction — then moves the retained rows
 * back through metric_rollups in short page-range batches (expired rows are
 * just not moved) and drops the drained table, which returns all of its
 * space. See migration 2026-11-14-100000-metric-rollups-default-drain.sql.
 *
 * Runs before `ensure`, so a month the default was blocking exists by the time
 * ensure looks at it. A step that fails leaves the drain table in place and is
 * recorded; the next run resumes the move before it ever swaps again.
 */
async function drainDefaultPartition(
  cutoffs: { fiveMinute: Date; hourly: Date; daily: Date },
  pagesPerBatch: number,
  failures: MetricRollupMaintenanceFailure[],
): Promise<MetricRollupDefaultDrainResult | typeof LOCK_HELD> {
  const drain: MetricRollupDefaultDrainResult = {
    blockedMonths: [],
    resumed: false,
    swapped: false,
    monthsCreated: [],
    rowsMoved: 0,
    rowsDiscarded: 0,
    completed: false,
  };
  const fail = (step: string, error: unknown) => {
    failures.push({ step, partition: 'metric_rollups_default', error: errorMessage(error) });
    return drain;
  };

  // The probe reads the default's months OUTSIDE the swap's lock: it is the one
  // full scan of the default, and it runs under an ordinary ACCESS SHARE.
  let probe: { pending: boolean; months: string[] } | typeof LOCK_HELD;
  try {
    probe = await inMaintenanceStep('drainProbe', async () => {
      const row = readRow(
        await db.execute(sql`
          SELECT
            public.breeze_metric_rollup_default_drain_exists() AS "pending",
            coalesce(
              (
                SELECT array_agg(month ORDER BY month)
                FROM (
                  SELECT DISTINCT to_char(date_trunc('month', bucket_start), 'YYYY-MM-DD HH24:MI:SS') AS month
                  FROM metric_rollups_default
                ) months
              ),
              ARRAY[]::text[]
            ) AS "months"
        `),
      );
      if (typeof row.pending !== 'boolean' || !Array.isArray(row.months)) {
        throw new Error('[MetricRollupMaintenance] drain probe returned an unexpected shape');
      }
      return { pending: row.pending, months: row.months.filter((m): m is string => typeof m === 'string') };
    });
  } catch (error) {
    return fail('drain-default-probe', error);
  }
  if (probe === LOCK_HELD) return LOCK_HELD;

  // Pure string mapping (no Date parsing), so an odd bucket_start can never
  // throw here and take the rest of the run down with it.
  drain.blockedMonths = probe.months.map((month) => {
    const match = /^(\d{4,})-(\d{2})-/.exec(month);
    return match ? `metric_rollups_y${match[1]}m${match[2]}` : month;
  });
  if (drain.blockedMonths.length > 0) {
    console.warn(
      `[MetricRollupMaintenance] metric_rollups_default holds rows for ${drain.blockedMonths.join(', ')}; draining it`,
    );
  }

  if (probe.pending) {
    drain.resumed = true;
  } else if (probe.months.length > 0) {
    let created: string[] | typeof LOCK_HELD;
    try {
      created = await inMaintenanceStep('drainSwap', async () => {
        const row = readRow(
          await db.execute(sql`
            SELECT public.breeze_swap_metric_rollup_default(
              ${`{${probe.months.map((m) => `"${m}"`).join(',')}}`}::timestamp[],
              ${formatTimestampLiteral(cutoffs.daily)}::timestamp
            ) AS "created"
          `),
        );
        if (!Array.isArray(row.created)) {
          throw new Error('[MetricRollupMaintenance] swap returned no created-months array');
        }
        return row.created.filter((name): name is string => typeof name === 'string');
      });
    } catch (error) {
      return fail('drain-default-swap', error);
    }
    if (created === LOCK_HELD) return fail('drain-default-swap', 'maintenance lock held by another run');
    drain.swapped = true;
    drain.monthsCreated = created;
  } else {
    drain.completed = true;
    return drain;
  }

  // Move the drain table back, one page range per short transaction.
  for (let page: number | null = 0; page !== null; ) {
    const fromPage: number = page;
    let batch: { nextPage: number | null; moved: number; discarded: number } | typeof LOCK_HELD;
    try {
      batch = await inMaintenanceStep('drainBatch', async () => {
        const row = readRow(
          await db.execute(sql`
            SELECT next_page AS "nextPage", rows_moved AS "moved", rows_discarded AS "discarded"
            FROM public.breeze_drain_metric_rollup_default_batch(
              ${fromPage}::bigint,
              ${pagesPerBatch}::integer,
              ${formatTimestampLiteral(cutoffs.fiveMinute)}::timestamp,
              ${formatTimestampLiteral(cutoffs.hourly)}::timestamp,
              ${formatTimestampLiteral(cutoffs.daily)}::timestamp
            )
          `),
        );
        return {
          nextPage: row.nextPage === null ? null : readCount(row.nextPage, 'next_page'),
          moved: readCount(row.moved, 'rows_moved'),
          discarded: readCount(row.discarded, 'rows_discarded'),
        };
      });
    } catch (error) {
      return fail('drain-default-move', error);
    }
    if (batch === LOCK_HELD) return fail('drain-default-move', 'maintenance lock held by another run');
    drain.rowsMoved += batch.moved;
    drain.rowsDiscarded += batch.discarded;
    if (batch.nextPage !== null && batch.nextPage <= fromPage) {
      return fail('drain-default-move', `drain batch did not advance past page ${fromPage}`);
    }
    page = batch.nextPage;
  }

  let finished: boolean | typeof LOCK_HELD;
  try {
    finished = await inMaintenanceStep('drainFinish', async () => {
      const row = readRow(await db.execute(sql`SELECT public.breeze_finish_metric_rollup_default_drain() AS "dropped"`));
      if (typeof row.dropped !== 'boolean') {
        throw new Error('[MetricRollupMaintenance] drain finish returned an unexpected shape');
      }
      return row.dropped;
    });
  } catch (error) {
    return fail('drain-default-finish', error);
  }
  if (finished === LOCK_HELD) return fail('drain-default-finish', 'maintenance lock held by another run');
  drain.completed = true;
  console.log(
    `[MetricRollupMaintenance] drained metric_rollups_default: moved=${drain.rowsMoved} discarded=${drain.rowsDiscarded}` +
      ` monthsCreated=${drain.monthsCreated.join(',') || 'none'} resumed=${drain.resumed}`,
  );
  return drain;
}

export async function runMetricRollupMaintenance(options: {
  now?: Date;
  partitionMonthsBack?: number;
  partitionMonthsAhead?: number;
  /** Ignored since #7541 (the default partition is drained, not row-deleted).
   * Still accepted because stored repeatable jobs carry it. */
  deleteBatchSize?: number;
  /** Drain-table pages moved per transaction (see drainDefaultPartition). */
  defaultDrainPagesPerBatch?: number;
  /** Test/ops override; normalized exactly like the env settings. */
  retentionDays?: Partial<MetricRollupRetentionDays>;
  /** Test override for COMPACTION_RETRY_BACKOFF_MS. */
  compactionRetryBackoffMs?: readonly number[];
  /** Test override for COMPACTION_RETRY_SLEEP_BUDGET_MS. */
  compactionRetrySleepBudgetMs?: number;
} = {}): Promise<MetricRollupMaintenanceResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  assertValidDate(now, 'now');
  const retentionDays = options.retentionDays
    ? normalizeMetricRollupRetentionDays({ ...METRIC_ROLLUP_BUCKET_RETENTION_DAYS, ...options.retentionDays })
    : METRIC_ROLLUP_BUCKET_RETENTION_DAYS;
  const cutoffs = metricRollupRetentionCutoffs(now, retentionDays);
  const drainPagesPerBatch = Math.max(
    1,
    Math.floor(options.defaultDrainPagesPerBatch ?? DEFAULT_METRIC_ROLLUP_DEFAULT_DRAIN_PAGES_PER_BATCH),
  );

  const result: MetricRollupMaintenanceResult = {
    ensuredPartitions: [],
    droppedPartitions: [],
    droppedBucketPartitions: [],
    compactedPartitions: [],
    defaultPartitionRowsDeleted: 0,
    defaultPartitionDrain: {
      blockedMonths: [],
      resumed: false,
      swapped: false,
      monthsCreated: [],
      rowsMoved: 0,
      rowsDiscarded: 0,
      completed: false,
    },
    retentionDays,
    cutoffs: {
      fiveMinute: cutoffs.fiveMinute.toISOString(),
      hourly: cutoffs.hourly.toISOString(),
      daily: cutoffs.daily.toISOString(),
    },
    failures: [],
    deferredCompactions: [],
    durationMs: 0,
  };
  const finish = (): MetricRollupMaintenanceResult => {
    result.durationMs = Date.now() - startedAt;
    return result;
  };

  // A step that throws is recorded and the run moves on: one month that cannot
  // get its lock today must not stop every other month's retention.
  async function step<T>(
    label: string,
    stepName: string,
    partition: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const value = await inMaintenanceStep(label, fn);
      if (value === LOCK_HELD) {
        result.failures.push({ step: stepName, partition, error: 'maintenance lock held by another run' });
        return undefined;
      }
      return value;
    } catch (error) {
      result.failures.push({ step: stepName, partition, error: errorMessage(error) });
      return undefined;
    }
  }

  // 0. Drain metric_rollups_default first, so the months it was blocking exist
  //    before ensure looks at them. If another run holds the lock, skip the
  //    whole run: reporting "ran, nothing to do" would be a lie.
  const drain = await drainDefaultPartition(cutoffs, drainPagesPerBatch, result.failures);
  if (drain === LOCK_HELD) {
    result.skipped = true;
    result.reason = 'maintenance lock already held';
    return finish();
  }
  result.defaultPartitionDrain = drain;
  result.defaultPartitionRowsDeleted = drain.rowsDiscarded;

  // 1. Partitions for the write window.
  let ensured: string[] | typeof LOCK_HELD;
  const skippedMonths: string[] = [];
  try {
    ensured = await inMaintenanceStep('ensure', () =>
      ensureMetricRollupPartitions({
        referenceDate: now,
        monthsBack: options.partitionMonthsBack,
        monthsAhead: options.partitionMonthsAhead,
        onSkipped: (name) => skippedMonths.push(name),
      }),
    );
  } catch (error) {
    result.failures.push({ step: 'ensure', partition: '*', error: errorMessage(error) });
    ensured = [];
  }
  if (ensured === LOCK_HELD) {
    result.skipped = true;
    result.reason = 'maintenance lock already held';
    return finish();
  }
  result.ensuredPartitions = ensured;
  // A month the default partition already holds rows for cannot be created, so
  // its writes keep landing in metric_rollups_default, where retention is only
  // a row DELETE and the space is never returned. That is the failure this
  // module exists to prevent, so it must not pass as a clean run.
  for (const name of skippedMonths) {
    result.failures.push({
      step: 'ensure',
      partition: name,
      error: 'metric_rollups_default already holds rows for this month, so its partition cannot be created',
    });
  }

  // 2. Retention, month by month.
  const retrySleep = { remainingMs: options.compactionRetrySleepBudgetMs ?? COMPACTION_RETRY_SLEEP_BUDGET_MS };
  const months = (await step('list', 'list', '*', () => listMetricRollupMonthPartitions())) ?? [];
  for (const month of months) {
    const monthEnd = addMonths(month.monthStart, 1).getTime();

    if (monthEnd <= cutoffs.daily.getTime()) {
      const dropped = await step('dropMonth', 'drop-month', month.name, () =>
        dropMonthPartition(month.monthStart, `drop ${month.name}`),
      );
      if (dropped) result.droppedPartitions.push(dropped);
      continue;
    }

    const fiveMinuteExpired = monthEnd <= cutoffs.fiveMinute.getTime();
    const hourlyExpired = monthEnd <= cutoffs.hourly.getTime();

    if (month.shape === 'bucketed') {
      const expired: RetainedBucketSeconds[] = [];
      if (fiveMinuteExpired) expired.push(300);
      if (hourlyExpired) expired.push(3600);
      for (const bucketSeconds of expired) {
        const leaf = metricRollupBucketPartitionName(month.monthStart, bucketSeconds);
        if (!month.leaves.includes(leaf)) continue;
        const dropped = await step('dropBucket', 'drop-bucket', leaf, () =>
          dropBucketPartition(month.monthStart, bucketSeconds, `drop ${leaf}`),
        );
        if (dropped) result.droppedBucketPartitions.push(dropped);
      }
      continue;
    }

    // Legacy flat month: rewrite it once its 5-minute rows have expired.
    if (!fiveMinuteExpired) continue;
    await compactLegacyMonth(month, {
      keepHourly: !hourlyExpired,
      overdueDays: Math.floor((cutoffs.fiveMinute.getTime() - monthEnd) / DAY_MS),
      backoffMs: options.compactionRetryBackoffMs ?? COMPACTION_RETRY_BACKOFF_MS,
      retrySleep,
      result,
    });
  }

  return finish();
}

/**
 * Rewrite one legacy flat month into per-bucket leaves.
 *
 * The SQL side takes its locks with NOWAIT so it can never queue readers or join
 * a deadlock (#10829). The price is that under steady traffic it can run out of
 * its attempts, and that raises 55P03. That is contention, not a fault, so
 * #10960 retries it after a wait instead of leaving the month for tomorrow, and
 * only reports a failure once the month has been overdue for
 * COMPACTION_STALL_AFTER_DAYS.
 *
 * Copy and cutover share one transaction, so a compact that loses the cutover
 * rolls back and its retry copies the month again. The copy freezes writes to
 * this one already-closed month and blocks only DDL on the referenced tables,
 * so the repeat costs I/O, not availability. Prepare's commit survives, so a
 * retry in the same run never re-prepares (which would need ACCESS EXCLUSIVE
 * to drop the stage it just built); the next night's run does re-prepare.
 *
 * Nothing here is lost when a month defers: it is still flat, so the next run
 * lists it and picks it up, and months already done are bucketed and skipped.
 */
async function compactLegacyMonth(
  month: MetricRollupMonthPartition,
  context: {
    keepHourly: boolean;
    overdueDays: number;
    backoffMs: readonly number[];
    /** The run's shared COMPACTION_RETRY_SLEEP_BUDGET_MS, drawn down here. */
    retrySleep: { remainingMs: number };
    result: MetricRollupMaintenanceResult;
  },
): Promise<void> {
  const { keepHourly, overdueDays, backoffMs, retrySleep, result } = context;
  const monthLiteral = formatTimestampLiteral(month.monthStart);
  let prepared = false;

  for (let attempt = 1; ; attempt += 1) {
    try {
      if (!prepared) {
        // Own transaction: adding the staged leaves' FKs locks devices and
        // organizations, and that lock must be released before the long copy.
        const name = await inMaintenanceStep('prepareCompaction', async () =>
          readPartitionNameResult(
            await db.execute(sql`
              SELECT public.breeze_prepare_metric_rollup_compaction(
                ${monthLiteral}::timestamp, ${keepHourly}
              ) AS "partitionName"
            `),
            `prepare compaction ${month.name}`,
          ),
        );
        if (name === LOCK_HELD) {
          result.failures.push({ step: 'prepare-compaction', partition: month.name, error: 'maintenance lock held by another run' });
          return;
        }
        if (name === null) return;
        prepared = true;
      }
      const name = await inMaintenanceStep('compact', async () =>
        readPartitionNameResult(
          await db.execute(sql`
            SELECT public.breeze_compact_metric_rollup_partition(
              ${monthLiteral}::timestamp, ${keepHourly}
            ) AS "partitionName"
          `),
          `compact ${month.name}`,
        ),
      );
      if (name === LOCK_HELD) {
        result.failures.push({ step: 'compact', partition: month.name, error: 'maintenance lock held by another run' });
        return;
      }
      if (name !== null) result.compactedPartitions.push(name);
      return;
    } catch (error) {
      const failedStep = prepared ? 'compact' : 'prepare-compaction';
      if (pgErrorCode(error) !== PG_LOCK_NOT_AVAILABLE) {
        result.failures.push({ step: failedStep, partition: month.name, error: errorMessage(error) });
        return;
      }
      const waitMs = backoffMs[attempt - 1];
      if (waitMs !== undefined && waitMs <= retrySleep.remainingMs) {
        retrySleep.remainingMs -= waitMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      const reason = String(pgErrorNode(error)?.message ?? errorMessage(error));
      const stalled = overdueDays >= COMPACTION_STALL_AFTER_DAYS;
      result.deferredCompactions.push({
        partition: month.name,
        step: failedStep,
        attempts: attempt,
        overdueDays,
        stalled,
        error: reason,
      });
      if (stalled) {
        result.failures.push({
          step: failedStep,
          partition: month.name,
          error: `stalled: ${overdueDays} days overdue for compaction, locks unavailable on all ${attempt} attempts this run: ${reason}`,
        });
      }
      return;
    }
  }
}
