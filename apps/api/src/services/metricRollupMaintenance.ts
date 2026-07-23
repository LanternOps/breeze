import { sql } from 'drizzle-orm';

import { db } from '../db';

export const METRIC_ROLLUP_BUCKET_RETENTION_DAYS = {
  fiveMinute: Math.max(30, parsePositiveIntEnv('METRIC_ROLLUP_5M_RETENTION_DAYS', 90)),
  hourly: Math.max(365, parsePositiveIntEnv('METRIC_ROLLUP_HOURLY_RETENTION_DAYS', 548)),
  daily: Math.max(730, parsePositiveIntEnv('METRIC_ROLLUP_DAILY_RETENTION_DAYS', 1095)),
} as const;

export const DEFAULT_METRIC_ROLLUP_DELETE_BATCH_SIZE = Math.max(
  100,
  parsePositiveIntEnv('METRIC_ROLLUP_DELETE_BATCH_SIZE', 5000),
);
export const DEFAULT_METRIC_ROLLUP_MAX_DELETE_BATCHES = Math.max(
  1,
  parsePositiveIntEnv('METRIC_ROLLUP_MAX_DELETE_BATCHES', 20),
);
export const DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_BACK = Math.max(
  0,
  parsePositiveIntEnv('METRIC_ROLLUP_PARTITION_MONTHS_BACK', 0),
);
export const DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_AHEAD = Math.max(
  1,
  parsePositiveIntEnv('METRIC_ROLLUP_PARTITION_MONTHS_AHEAD', 3),
);

type EnsurePartitionOptions = {
  referenceDate?: Date;
  monthsBack?: number;
  monthsAhead?: number;
};

type DeleteOptions = {
  bucketSeconds: 300 | 3600 | 86400;
  cutoff: Date;
  batchSize?: number;
  maxBatches?: number;
};

export type MetricRollupBucketRetentionResult = {
  bucketSeconds: 300 | 3600 | 86400;
  retentionDays: number;
  cutoff: string;
  deleted: number;
  batches: number;
  hasMore: boolean;
};

export type MetricRollupMaintenanceResult = {
  ensuredPartitions: string[];
  droppedPartitions: string[];
  retention: MetricRollupBucketRetentionResult[];
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

function monthStartUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function formatTimestampLiteral(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function isDefaultPartitionOverlapError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  return (
    message.includes('updated partition constraint for default partition') &&
    message.includes('would be violated by some row')
  );
}

export function metricRollupPartitionName(monthStart: Date): string {
  assertValidDate(monthStart, 'monthStart');
  return `metric_rollups_y${monthStart.getUTCFullYear()}m${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;
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

export function extractRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? result.length : 0;
}

async function tryAcquireMaintenanceLock(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT pg_try_advisory_lock(hashtext('metric_rollup_maintenance')) AS "acquired"
  `);
  const row = Array.isArray(result) ? (result[0] as { acquired?: unknown } | undefined) : undefined;
  return row?.acquired === true;
}

async function releaseMaintenanceLock(): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(hashtext('metric_rollup_maintenance'))`);
}

export async function ensureMetricRollupPartitions(options: EnsurePartitionOptions = {}): Promise<string[]> {
  const referenceDate = options.referenceDate ?? new Date();
  assertValidDate(referenceDate, 'referenceDate');

  const monthsBack = Math.max(0, options.monthsBack ?? DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_BACK);
  const monthsAhead = Math.max(1, options.monthsAhead ?? DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_AHEAD);
  const anchor = monthStartUtc(referenceDate);
  const ensured: string[] = [];

  for (let offset = -monthsBack; offset <= monthsAhead; offset += 1) {
    const from = addMonths(anchor, offset);
    const to = addMonths(from, 1);
    const partitionName = metricRollupPartitionName(from);
    const partitionIdentifier = sql.raw(quoteIdentifier(partitionName));
    const fromLiteral = sql.raw(`'${formatTimestampLiteral(from)}'::timestamp`);
    const toLiteral = sql.raw(`'${formatTimestampLiteral(to)}'::timestamp`);

    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS ${partitionIdentifier}
          PARTITION OF metric_rollups
          FOR VALUES FROM (${fromLiteral}) TO (${toLiteral});
      `);
    } catch (error) {
      if (isDefaultPartitionOverlapError(error)) {
        console.warn(
          `[MetricRollupMaintenance] Skipping ${partitionName}; metric_rollups_default already contains rows for that month`,
        );
        continue;
      }
      throw error;
    }
    await db.execute(sql`ALTER TABLE ${partitionIdentifier} ENABLE ROW LEVEL SECURITY`);
    await db.execute(sql`ALTER TABLE ${partitionIdentifier} FORCE ROW LEVEL SECURITY`);
    await db.execute(sql`DROP POLICY IF EXISTS breeze_org_isolation_select ON ${partitionIdentifier}`);
    await db.execute(sql`DROP POLICY IF EXISTS breeze_org_isolation_insert ON ${partitionIdentifier}`);
    await db.execute(sql`DROP POLICY IF EXISTS breeze_org_isolation_update ON ${partitionIdentifier}`);
    await db.execute(sql`DROP POLICY IF EXISTS breeze_org_isolation_delete ON ${partitionIdentifier}`);
    await db.execute(sql`
      CREATE POLICY breeze_org_isolation_select ON ${partitionIdentifier}
        FOR SELECT USING (public.breeze_has_org_access(org_id))
    `);
    await db.execute(sql`
      CREATE POLICY breeze_org_isolation_insert ON ${partitionIdentifier}
        FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))
    `);
    await db.execute(sql`
      CREATE POLICY breeze_org_isolation_update ON ${partitionIdentifier}
        FOR UPDATE USING (public.breeze_has_org_access(org_id))
        WITH CHECK (public.breeze_has_org_access(org_id))
    `);
    await db.execute(sql`
      CREATE POLICY breeze_org_isolation_delete ON ${partitionIdentifier}
        FOR DELETE USING (public.breeze_has_org_access(org_id))
    `);
    await db.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${partitionIdentifier} TO breeze_app`);
    ensured.push(partitionName);
  }

  return ensured;
}

export async function listMetricRollupPartitions(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT child.relname AS "partitionName"
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE parent.relname = 'metric_rollups'
      AND parent_ns.nspname = 'public'
      AND child_ns.nspname = 'public'
      AND child.relname LIKE 'metric_rollups_y____m__'
    ORDER BY child.relname
  `);

  return (Array.isArray(result) ? result : [])
    .map((row) => (row as { partitionName?: unknown }).partitionName)
    .filter((value): value is string => typeof value === 'string');
}

export async function dropExpiredMetricRollupPartitions(now = new Date()): Promise<string[]> {
  assertValidDate(now, 'now');
  const dailyCutoff = new Date(now.getTime() - METRIC_ROLLUP_BUCKET_RETENTION_DAYS.daily * 24 * 60 * 60 * 1000);
  const partitionNames = await listMetricRollupPartitions();
  const dropped: string[] = [];

  for (const partitionName of partitionNames) {
    const partitionStart = parseMetricRollupPartitionMonth(partitionName);
    if (!partitionStart) continue;

    const partitionEnd = addMonths(partitionStart, 1);
    if (partitionEnd.getTime() > dailyCutoff.getTime()) continue;

    await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(quoteIdentifier(partitionName))}`);
    dropped.push(partitionName);
  }

  return dropped;
}

export async function deleteExpiredMetricRollupsForBucket(options: DeleteOptions): Promise<{
  deleted: number;
  batches: number;
  hasMore: boolean;
}> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_METRIC_ROLLUP_DELETE_BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_METRIC_ROLLUP_MAX_DELETE_BATCHES);
  assertValidDate(options.cutoff, 'cutoff');

  let deleted = 0;
  let batches = 0;
  let lastBatchCount = 0;

  for (let attempted = 0; attempted < maxBatches; attempted += 1) {
    const result = await db.execute(sql`
      WITH doomed AS (
        SELECT tableoid, ctid
        FROM metric_rollups
        WHERE bucket_seconds = ${options.bucketSeconds}
          AND bucket_start < ${options.cutoff.toISOString()}::timestamp
        ORDER BY bucket_start
        LIMIT ${batchSize}
      )
      DELETE FROM metric_rollups AS mr
      USING doomed
      WHERE mr.tableoid = doomed.tableoid
        AND mr.ctid = doomed.ctid
      RETURNING 1
    `);
    lastBatchCount = extractRowCount(result);
    batches += 1;
    deleted += lastBatchCount;
    if (lastBatchCount < batchSize) break;
  }

  return {
    deleted,
    batches,
    hasMore: lastBatchCount === batchSize && batches === maxBatches,
  };
}

export async function pruneMetricRollups(options: {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
} = {}): Promise<MetricRollupBucketRetentionResult[]> {
  const now = options.now ?? new Date();
  assertValidDate(now, 'now');

  const tiers: Array<{ bucketSeconds: 300 | 3600 | 86400; retentionDays: number }> = [
    { bucketSeconds: 300, retentionDays: METRIC_ROLLUP_BUCKET_RETENTION_DAYS.fiveMinute },
    { bucketSeconds: 3600, retentionDays: METRIC_ROLLUP_BUCKET_RETENTION_DAYS.hourly },
    { bucketSeconds: 86400, retentionDays: METRIC_ROLLUP_BUCKET_RETENTION_DAYS.daily },
  ];

  const results: MetricRollupBucketRetentionResult[] = [];
  for (const tier of tiers) {
    const cutoff = new Date(now.getTime() - tier.retentionDays * 24 * 60 * 60 * 1000);
    const result = await deleteExpiredMetricRollupsForBucket({
      bucketSeconds: tier.bucketSeconds,
      cutoff,
      batchSize: options.batchSize,
      maxBatches: options.maxBatches,
    });
    results.push({
      bucketSeconds: tier.bucketSeconds,
      retentionDays: tier.retentionDays,
      cutoff: cutoff.toISOString(),
      deleted: result.deleted,
      batches: result.batches,
      hasMore: result.hasMore,
    });
  }

  return results;
}

export async function runMetricRollupMaintenance(options: {
  now?: Date;
  partitionMonthsBack?: number;
  partitionMonthsAhead?: number;
  deleteBatchSize?: number;
  maxDeleteBatches?: number;
} = {}): Promise<MetricRollupMaintenanceResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  assertValidDate(now, 'now');

  const acquired = await tryAcquireMaintenanceLock();
  if (!acquired) {
    return {
      ensuredPartitions: [],
      droppedPartitions: [],
      retention: [],
      durationMs: Date.now() - startedAt,
      skipped: true,
      reason: 'maintenance lock already held',
    };
  }

  try {
    const ensuredPartitions = await ensureMetricRollupPartitions({
      referenceDate: now,
      monthsBack: options.partitionMonthsBack,
      monthsAhead: options.partitionMonthsAhead,
    });
    const droppedPartitions = await dropExpiredMetricRollupPartitions(now);
    const retention = await pruneMetricRollups({
      now,
      batchSize: options.deleteBatchSize,
      maxBatches: options.maxDeleteBatches,
    });

    return {
      ensuredPartitions,
      droppedPartitions,
      retention,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // A poisoned transaction (25P02 — an earlier DDL/DELETE in this same
    // withSystemDbAccessContext transaction already failed) or a dropped
    // session makes the advisory unlock throw. A throw from `finally` REPLACES
    // fn's real error, so the true root cause was invisible in Sentry — only
    // the secondary pg_advisory_unlock failure surfaced (BREEZE-M). Swallow it
    // so the original error propagates; the session-scoped advisory lock is
    // released on connection recycle regardless.
    try {
      await releaseMaintenanceLock();
    } catch (err) {
      console.error(
        '[MetricRollupMaintenance] releaseMaintenanceLock failed; advisory lock will release on connection recycle:',
        err,
      );
    }
  }
}
