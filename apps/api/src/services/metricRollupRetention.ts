/**
 * Retention windows for `metric_rollups`, one per bucket size (#7531).
 *
 * Each month of `metric_rollups` is sub-partitioned by bucket size, and each
 * bucket's retention is enforced by dropping that bucket's leaf once the whole
 * month is past the cutoff (see `metricRollupMaintenance.ts`). Both the
 * maintenance job and the rollup writer read the windows from here, so the
 * writer never routes a row into a leaf that retention has already dropped.
 */

export type MetricRollupRetentionDays = {
  fiveMinute: number;
  hourly: number;
  daily: number;
};

/**
 * Floors. The SQL drop/compact functions refuse anything younger than the 5m
 * and hourly floors as defense in depth, so keep these two in step with
 * migration 2026-11-10-130000-metric-rollups-bucket-partitions.sql.
 */
export const METRIC_ROLLUP_RETENTION_FLOOR_DAYS: MetricRollupRetentionDays = {
  fiveMinute: 30,
  hourly: 365,
  daily: 730,
};

export const METRIC_ROLLUP_RETENTION_DEFAULT_DAYS: MetricRollupRetentionDays = {
  fiveMinute: 90,
  hourly: 548,
  daily: 1095,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[MetricRollupRetention] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Applies the floors, then makes the windows monotonic (daily >= hourly >=
 * 5-minute). Monotonic is load-bearing, not cosmetic: hourly buckets are
 * derived from 5-minute rows and daily from hourly, and a whole month is
 * dropped at the daily cutoff. With hourly < 5-minute the writer could derive
 * an hourly row into a month whose `_1h` leaf is already gone, and a daily
 * cutoff shorter than the others would drop still-retained finer buckets with
 * the month.
 */
export function normalizeMetricRollupRetentionDays(
  input: Partial<MetricRollupRetentionDays> = {},
): MetricRollupRetentionDays {
  const fiveMinute = Math.max(
    METRIC_ROLLUP_RETENTION_FLOOR_DAYS.fiveMinute,
    input.fiveMinute ?? METRIC_ROLLUP_RETENTION_DEFAULT_DAYS.fiveMinute,
  );
  const hourly = Math.max(
    METRIC_ROLLUP_RETENTION_FLOOR_DAYS.hourly,
    input.hourly ?? METRIC_ROLLUP_RETENTION_DEFAULT_DAYS.hourly,
    fiveMinute,
  );
  const daily = Math.max(
    METRIC_ROLLUP_RETENTION_FLOOR_DAYS.daily,
    input.daily ?? METRIC_ROLLUP_RETENTION_DEFAULT_DAYS.daily,
    hourly,
  );
  return { fiveMinute, hourly, daily };
}

/** The configured windows: `METRIC_ROLLUP_{5M,HOURLY,DAILY}_RETENTION_DAYS`. */
export function metricRollupRetentionDaysFromEnv(): MetricRollupRetentionDays {
  return normalizeMetricRollupRetentionDays({
    fiveMinute: parsePositiveIntEnv('METRIC_ROLLUP_5M_RETENTION_DAYS', METRIC_ROLLUP_RETENTION_DEFAULT_DAYS.fiveMinute),
    hourly: parsePositiveIntEnv('METRIC_ROLLUP_HOURLY_RETENTION_DAYS', METRIC_ROLLUP_RETENTION_DEFAULT_DAYS.hourly),
    daily: parsePositiveIntEnv('METRIC_ROLLUP_DAILY_RETENTION_DAYS', METRIC_ROLLUP_RETENTION_DEFAULT_DAYS.daily),
  });
}

export const METRIC_ROLLUP_BUCKET_RETENTION_DAYS: MetricRollupRetentionDays = metricRollupRetentionDaysFromEnv();

export type MetricRollupRetentionCutoffs = {
  fiveMinute: Date;
  hourly: Date;
  daily: Date;
};

export function metricRollupRetentionCutoffs(
  now: Date,
  retention: MetricRollupRetentionDays = METRIC_ROLLUP_BUCKET_RETENTION_DAYS,
): MetricRollupRetentionCutoffs {
  return {
    fiveMinute: new Date(now.getTime() - retention.fiveMinute * DAY_MS),
    hourly: new Date(now.getTime() - retention.hourly * DAY_MS),
    daily: new Date(now.getTime() - retention.daily * DAY_MS),
  };
}

export function monthStartUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/**
 * The earliest `bucket_start` the rollup writer may produce 5-minute rows for.
 *
 * A month's `_5m` leaf is dropped only once the WHOLE month is older than the
 * 5-minute cutoff, so every row at or after the start of the cutoff's own
 * month still has a leaf to land in. Clamping to the month start (rather than
 * to the cutoff instant) also keeps the raw pass aligned to whole buckets: a
 * clamp that split a 5-minute bucket would recompute it from partial input and
 * overwrite a correct row.
 */
export function metricRollupRawWriteFloor(
  now: Date,
  retention: MetricRollupRetentionDays = METRIC_ROLLUP_BUCKET_RETENTION_DAYS,
): Date {
  return monthStartUtc(metricRollupRetentionCutoffs(now, retention).fiveMinute);
}
