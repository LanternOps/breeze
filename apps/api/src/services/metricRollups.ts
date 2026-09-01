import { sql, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { shouldProduceMlOutput } from './mlFeatureFlags';
import { recordRollupRun } from './retentionMetrics';

export const METRIC_ROLLUP_VERSION = 'metric-rollups-v1';

export const METRIC_ROLLUP_BUCKETS = [300, 3600, 86400] as const;
export type MetricRollupBucketSeconds = (typeof METRIC_ROLLUP_BUCKETS)[number];

const RAW_BUCKET_SECONDS = 300;
const HOUR_BUCKET_SECONDS = 3600;
const DAY_BUCKET_SECONDS = 86400;
const DEFAULT_EXPECTED_SAMPLE_SECONDS = 60;

const DEVICE_METRIC_ROLLUP_SOURCES = [
  { metricType: 'cpu', metricName: 'cpu_percent', column: 'cpu_percent' },
  { metricType: 'memory', metricName: 'ram_percent', column: 'ram_percent' },
  { metricType: 'memory', metricName: 'ram_used_mb', column: 'ram_used_mb' },
  { metricType: 'disk', metricName: 'disk_percent', column: 'disk_percent' },
  { metricType: 'disk', metricName: 'disk_used_gb', column: 'disk_used_gb' },
  { metricType: 'disk', metricName: 'disk_read_bps', column: 'disk_read_bps' },
  { metricType: 'disk', metricName: 'disk_write_bps', column: 'disk_write_bps' },
  { metricType: 'network', metricName: 'bandwidth_in_bps', column: 'bandwidth_in_bps' },
  { metricType: 'network', metricName: 'bandwidth_out_bps', column: 'bandwidth_out_bps' },
  { metricType: 'process', metricName: 'process_count', column: 'process_count' },
] as const;

const PROCESS_SAMPLE_ROLLUP_SOURCES = [
  {
    metricName: 'top_process_count',
    valueSql: 'jsonb_array_length(dps.top_processes)::double precision',
  },
  {
    metricName: 'top_process_cpu_percent_sum',
    valueSql: `(SELECT coalesce(sum(
      CASE WHEN jsonb_typeof(proc.value -> 'cpu') = 'number'
        THEN (proc.value ->> 'cpu')::double precision
        ELSE 0
      END
    ), 0)::double precision FROM jsonb_array_elements(dps.top_processes) AS proc(value))`,
  },
  {
    metricName: 'top_process_cpu_percent_max',
    valueSql: `(SELECT coalesce(max(
      CASE WHEN jsonb_typeof(proc.value -> 'cpu') = 'number'
        THEN (proc.value ->> 'cpu')::double precision
        ELSE NULL
      END
    ), 0)::double precision FROM jsonb_array_elements(dps.top_processes) AS proc(value))`,
  },
  {
    metricName: 'top_process_ram_mb_sum',
    valueSql: `(SELECT coalesce(sum(
      CASE WHEN jsonb_typeof(proc.value -> 'ramMb') = 'number'
        THEN (proc.value ->> 'ramMb')::double precision
        ELSE 0
      END
    ), 0)::double precision FROM jsonb_array_elements(dps.top_processes) AS proc(value))`,
  },
  {
    metricName: 'top_process_ram_mb_max',
    valueSql: `(SELECT coalesce(max(
      CASE WHEN jsonb_typeof(proc.value -> 'ramMb') = 'number'
        THEN (proc.value ->> 'ramMb')::double precision
        ELSE NULL
      END
    ), 0)::double precision FROM jsonb_array_elements(dps.top_processes) AS proc(value))`,
  },
  {
    metricName: 'top_process_disk_bps_sum',
    valueSql: `(SELECT coalesce(sum(
      CASE WHEN jsonb_typeof(proc.value -> 'diskBps') = 'number'
        THEN (proc.value ->> 'diskBps')::double precision
        ELSE 0
      END
    ), 0)::double precision FROM jsonb_array_elements(dps.top_processes) AS proc(value))`,
  },
  {
    metricName: 'top_process_net_bps_sum',
    valueSql: `(SELECT coalesce(sum(
      CASE WHEN jsonb_typeof(proc.value -> 'netBps') = 'number'
        THEN (proc.value ->> 'netBps')::double precision
        ELSE 0
      END
    ), 0)::double precision FROM jsonb_array_elements(dps.top_processes) AS proc(value))`,
  },
] as const;

export interface MetricRollupRange {
  orgId: string;
  from: Date;
  to: Date;
  expectedSampleSeconds?: number;
}

export interface MetricRollupResult {
  orgId: string;
  from: string;
  to: string;
  statements: number;
  skipped: boolean;
}

function bucketStartSql(timestampSql: SQL, bucketSeconds: number): SQL<Date> {
  const bucketSecondsSql = sql.raw(String(bucketSeconds));
  // Bucket entirely in timestamp-without-tz space via date_bin (Postgres 14+).
  // The previous to_timestamp(...)::timestamp round-trip shifted buckets by the
  // session TZ offset on any non-UTC DB session, diverging from the raw path
  // (generate_series over ::timestamp). date_bin never converts to/from timestamptz,
  // so it stays aligned with the raw grid regardless of the session timezone.
  return sql<Date>`date_bin(make_interval(secs => ${bucketSecondsSql}), ${timestampSql}, timestamp 'epoch')`;
}

function upsertAssignments(): SQL {
  return sql`
    avg_value = EXCLUDED.avg_value,
    min_value = EXCLUDED.min_value,
    max_value = EXCLUDED.max_value,
    p95_value = EXCLUDED.p95_value,
    sum_value = EXCLUDED.sum_value,
    sample_count = EXCLUDED.sample_count,
    gap_seconds = EXCLUDED.gap_seconds,
    metadata = EXCLUDED.metadata,
    updated_at = now()
  `;
}

function normalizeRange(from: Date, to: Date): { from: Date; to: Date } {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Invalid metric rollup range');
  }
  if (from >= to) {
    throw new Error('Metric rollup range must have from < to');
  }
  return { from, to };
}

/**
 * #4276 — run ONE statement inside its OWN short-lived system RLS context.
 *
 * This module used to run under a single caller-supplied
 * `withSystemDbAccessContext`, so all 26 statements shared one transaction and
 * pinned one pooled connection for the whole pass. At ~2s+ per org every 5
 * minutes that made `metricRollupsWorker` the top `db_context_held_too_long`
 * offender (983 events/7d, ~half the system-scope capture budget) and it is
 * exactly the kind of long single-connection hold that elongates recovery when
 * the pool degrades (#3225).
 *
 * Nothing here needed the atomicity: every statement is an idempotent
 * `INSERT … SELECT … ON CONFLICT DO UPDATE`, so a pass that dies halfway leaves
 * a partially-refreshed set of rollups that the next 5-minute run re-upserts.
 * Splitting also removes a real hazard rather than only trading one: the
 * derived passes read rows the raw passes just wrote, and across transactions
 * they read them COMMITTED instead of from the writer's own snapshot.
 *
 * `runOutsideDbContext` is not decoration. Without it, a caller that wrapped
 * this function in its own context would make `withDbAccessContext`
 * short-circuit into that ambient transaction, silently collapsing all the
 * per-statement contexts back into one long hold — the alertWorker/#3216 trap.
 * WITH the escape, an outer wrap is instead defeated: it does no work and just
 * pins an idle-in-transaction connection for the whole pass (an unlabeled
 * #3218-shape hold, plus a second pool slot). So callers must not wrap this
 * function at all — the worker, backfill script and integration suite all call
 * it bare.
 *
 * `label` is REQUIRED here, not optional: under the tsup single-file bundle
 * every opener in this file is an anonymous arrow that `parseOpenerFrame`
 * collapses to a bare `index`. Keep the label set low-cardinality — one per
 * rollup pass, never per org or per metric — because it becomes part of the
 * grouped Sentry message.
 */
function inRollupDbContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/** One rollup statement, in its own context. */
function execInRollupDbContext(label: string, statement: SQL): Promise<unknown> {
  return inRollupDbContext(label, () => db.execute(statement));
}

function expandRangeToBucketBounds(from: Date, to: Date, bucketSeconds: number): { from: Date; to: Date } {
  const bucketMs = bucketSeconds * 1000;
  return {
    from: new Date(Math.floor(from.getTime() / bucketMs) * bucketMs),
    to: new Date(Math.ceil(to.getTime() / bucketMs) * bucketMs),
  };
}

async function rollupRawDeviceMetric(options: MetricRollupRange, metric: (typeof DEVICE_METRIC_ROLLUP_SOURCES)[number]): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const expectedSampleSeconds = options.expectedSampleSeconds ?? DEFAULT_EXPECTED_SAMPLE_SECONDS;
  const valueSql = sql.raw(`dm.${metric.column}`);

  await execInRollupDbContext('metricRollups.raw.device_metrics', sql`
    WITH metric_devices AS (
      SELECT DISTINCT dm.org_id, dm.device_id
      FROM device_metrics dm
      WHERE dm.org_id = ${options.orgId}
        AND dm.timestamp >= ${fromIso}::timestamp
        AND dm.timestamp < ${toIso}::timestamp
        AND ${valueSql} IS NOT NULL
    ),
    buckets AS (
      SELECT generate_series(
        ${fromIso}::timestamp,
        ${toIso}::timestamp - interval '1 second' * ${RAW_BUCKET_SECONDS},
        interval '1 second' * ${RAW_BUCKET_SECONDS}
      )::timestamp AS bucket_start
    ),
    bucket_grid AS (
      SELECT md.org_id, md.device_id, buckets.bucket_start
      FROM metric_devices md
      CROSS JOIN buckets
    )
    INSERT INTO metric_rollups (
      org_id,
      source_table,
      device_id,
      metric_type,
      metric_name,
      bucket_start,
      bucket_seconds,
      avg_value,
      min_value,
      max_value,
      p95_value,
      sum_value,
      sample_count,
      gap_seconds,
      metadata
    )
    SELECT
      bg.org_id,
      'device_metrics',
      bg.device_id,
      ${metric.metricType},
      ${metric.metricName},
      bg.bucket_start,
      ${RAW_BUCKET_SECONDS},
      avg(${valueSql})::double precision,
      min(${valueSql})::double precision,
      max(${valueSql})::double precision,
      percentile_cont(0.95) within group (order by ${valueSql})::double precision,
      sum(${valueSql})::double precision,
      count(${valueSql})::integer,
      greatest(${RAW_BUCKET_SECONDS} - (count(${valueSql})::integer * ${expectedSampleSeconds}), 0)::integer,
      jsonb_build_object(
        'rollupVersion', ${METRIC_ROLLUP_VERSION}::text,
        'source', 'raw',
        'expectedSampleSeconds', ${expectedSampleSeconds}::integer,
        'isGap', count(${valueSql}) = 0
      )
    FROM bucket_grid bg
    LEFT JOIN device_metrics dm
      ON dm.org_id = bg.org_id
      AND dm.device_id = bg.device_id
      -- join window bound: constrain the scan to [from,to). bucket_start comes
      -- from generate_series, so the per-bucket predicates below are NOT sargable
      -- and Postgres would bitmap-scan each device's ENTIRE metric history per
      -- bucket. These two constant bounds let it index-range only the window.
      AND dm.timestamp >= ${fromIso}::timestamp
      AND dm.timestamp < ${toIso}::timestamp
      AND dm.timestamp >= bg.bucket_start
      AND dm.timestamp < bg.bucket_start + (interval '1 second' * ${RAW_BUCKET_SECONDS})
      AND ${valueSql} IS NOT NULL
    GROUP BY bg.org_id, bg.device_id, bg.bucket_start
    ON CONFLICT (org_id, source_table, device_id, metric_type, metric_name, bucket_seconds, bucket_start)
    DO UPDATE SET ${upsertAssignments()}
  `);
}

async function rollupRawProcessSampleMetric(options: MetricRollupRange, metric: (typeof PROCESS_SAMPLE_ROLLUP_SOURCES)[number]): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const expectedSampleSeconds = options.expectedSampleSeconds ?? DEFAULT_EXPECTED_SAMPLE_SECONDS;
  const valueSql = sql.raw(metric.valueSql);

  await execInRollupDbContext('metricRollups.raw.device_process_samples', sql`
    WITH process_devices AS (
      SELECT DISTINCT dps.org_id, dps.device_id
      FROM device_process_samples dps
      WHERE dps.org_id = ${options.orgId}
        AND dps.timestamp >= ${fromIso}::timestamp
        AND dps.timestamp < ${toIso}::timestamp
    ),
    buckets AS (
      SELECT generate_series(
        ${fromIso}::timestamp,
        ${toIso}::timestamp - interval '1 second' * ${RAW_BUCKET_SECONDS},
        interval '1 second' * ${RAW_BUCKET_SECONDS}
      )::timestamp AS bucket_start
    ),
    bucket_grid AS (
      SELECT pd.org_id, pd.device_id, buckets.bucket_start
      FROM process_devices pd
      CROSS JOIN buckets
    ),
    sample_values AS (
      SELECT
        dps.org_id,
        dps.device_id,
        dps.timestamp,
        ${valueSql} AS metric_value
      FROM device_process_samples dps
      WHERE dps.org_id = ${options.orgId}
        AND dps.timestamp >= ${fromIso}::timestamp
        AND dps.timestamp < ${toIso}::timestamp
    )
    INSERT INTO metric_rollups (
      org_id,
      source_table,
      device_id,
      metric_type,
      metric_name,
      bucket_start,
      bucket_seconds,
      avg_value,
      min_value,
      max_value,
      p95_value,
      sum_value,
      sample_count,
      gap_seconds,
      metadata
    )
    SELECT
      bg.org_id,
      'device_process_samples',
      bg.device_id,
      'process',
      ${metric.metricName},
      bg.bucket_start,
      ${RAW_BUCKET_SECONDS},
      avg(sv.metric_value)::double precision,
      min(sv.metric_value)::double precision,
      max(sv.metric_value)::double precision,
      percentile_cont(0.95) within group (order by sv.metric_value)::double precision,
      sum(sv.metric_value)::double precision,
      count(sv.metric_value)::integer,
      greatest(${RAW_BUCKET_SECONDS} - (count(sv.metric_value)::integer * ${expectedSampleSeconds}), 0)::integer,
      jsonb_build_object(
        'rollupVersion', ${METRIC_ROLLUP_VERSION}::text,
        'source', 'raw',
        'sourceTable', 'device_process_samples',
        'expectedSampleSeconds', ${expectedSampleSeconds}::integer,
        'isGap', count(sv.metric_value) = 0
      )
    FROM bucket_grid bg
    LEFT JOIN sample_values sv
      ON sv.org_id = bg.org_id
      AND sv.device_id = bg.device_id
      AND sv.timestamp >= bg.bucket_start
      AND sv.timestamp < bg.bucket_start + (interval '1 second' * ${RAW_BUCKET_SECONDS})
    GROUP BY bg.org_id, bg.device_id, bg.bucket_start
    ON CONFLICT (org_id, source_table, device_id, metric_type, metric_name, bucket_seconds, bucket_start)
    DO UPDATE SET ${upsertAssignments()}
  `);
}

async function rollupRawSnmpMetrics(options: MetricRollupRange): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const expectedSampleSeconds = options.expectedSampleSeconds ?? DEFAULT_EXPECTED_SAMPLE_SECONDS;

  await execInRollupDbContext('metricRollups.raw.snmp_metrics', sql`
    WITH snmp_values AS (
      SELECT
        sm.org_id,
        da.linked_device_id AS device_id,
        sm.device_id AS snmp_device_id,
        sm.oid,
        sm.name,
        left(
          regexp_replace(coalesce(nullif(sm.name, ''), sm.oid), '[^a-zA-Z0-9_.:-]+', '_', 'g')
            || ':' || md5(sm.device_id::text || ':' || sm.oid),
          120
        ) AS metric_name,
        CASE
          WHEN btrim(sm.value) ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN btrim(sm.value)::double precision
          ELSE NULL
        END AS metric_value,
        sm.timestamp
      FROM snmp_metrics sm
      JOIN snmp_devices sd
        ON sd.id = sm.device_id
        AND sd.org_id = sm.org_id
      JOIN discovered_assets da
        ON da.id = sd.asset_id
        AND da.org_id = sm.org_id
        AND da.linked_device_id IS NOT NULL
      JOIN devices d
        ON d.id = da.linked_device_id
        AND d.org_id = sm.org_id
      WHERE sm.org_id = ${options.orgId}
        AND sm.timestamp >= ${fromIso}::timestamp
        AND sm.timestamp < ${toIso}::timestamp
    ),
    snmp_series AS (
      SELECT DISTINCT
        org_id,
        device_id,
        snmp_device_id,
        oid,
        name,
        metric_name
      FROM snmp_values
      WHERE metric_value IS NOT NULL
    ),
    buckets AS (
      SELECT generate_series(
        ${fromIso}::timestamp,
        ${toIso}::timestamp - interval '1 second' * ${RAW_BUCKET_SECONDS},
        interval '1 second' * ${RAW_BUCKET_SECONDS}
      )::timestamp AS bucket_start
    ),
    bucket_grid AS (
      SELECT
        ss.org_id,
        ss.device_id,
        ss.snmp_device_id,
        ss.oid,
        ss.name,
        ss.metric_name,
        buckets.bucket_start
      FROM snmp_series ss
      CROSS JOIN buckets
    )
    INSERT INTO metric_rollups (
      org_id,
      source_table,
      device_id,
      metric_type,
      metric_name,
      bucket_start,
      bucket_seconds,
      avg_value,
      min_value,
      max_value,
      p95_value,
      sum_value,
      sample_count,
      gap_seconds,
      metadata
    )
    SELECT
      bg.org_id,
      'snmp_metrics',
      bg.device_id,
      'snmp',
      bg.metric_name,
      bg.bucket_start,
      ${RAW_BUCKET_SECONDS},
      avg(sv.metric_value)::double precision,
      min(sv.metric_value)::double precision,
      max(sv.metric_value)::double precision,
      percentile_cont(0.95) within group (order by sv.metric_value)::double precision,
      sum(sv.metric_value)::double precision,
      count(sv.metric_value)::integer,
      greatest(${RAW_BUCKET_SECONDS} - (count(sv.metric_value)::integer * ${expectedSampleSeconds}), 0)::integer,
      jsonb_build_object(
        'rollupVersion', ${METRIC_ROLLUP_VERSION}::text,
        'source', 'raw',
        'sourceTable', 'snmp_metrics',
        'expectedSampleSeconds', ${expectedSampleSeconds}::integer,
        'isGap', count(sv.metric_value) = 0,
        'snmpDeviceId', bg.snmp_device_id,
        'oid', bg.oid,
        'displayName', bg.name
      )
    FROM bucket_grid bg
    LEFT JOIN snmp_values sv
      ON sv.org_id = bg.org_id
      AND sv.device_id = bg.device_id
      AND sv.snmp_device_id = bg.snmp_device_id
      AND sv.oid = bg.oid
      AND sv.metric_name = bg.metric_name
      AND sv.timestamp >= bg.bucket_start
      AND sv.timestamp < bg.bucket_start + (interval '1 second' * ${RAW_BUCKET_SECONDS})
      AND sv.metric_value IS NOT NULL
    GROUP BY bg.org_id, bg.device_id, bg.snmp_device_id, bg.oid, bg.name, bg.metric_name, bg.bucket_start
    ON CONFLICT (org_id, source_table, device_id, metric_type, metric_name, bucket_seconds, bucket_start)
    DO UPDATE SET ${upsertAssignments()}
  `);
}

async function rollupDerivedMetricSource(
  options: MetricRollupRange,
  sourceTable: 'device_metrics' | 'device_process_samples' | 'snmp_metrics',
  sourceBucketSeconds: MetricRollupBucketSeconds,
  targetBucketSeconds: MetricRollupBucketSeconds,
): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const sourceRange = expandRangeToBucketBounds(from, to, targetBucketSeconds);
  const fromIso = sourceRange.from.toISOString();
  const toIso = sourceRange.to.toISOString();
  const targetBucketSql = bucketStartSql(sql`mr.bucket_start`, targetBucketSeconds);

  await execInRollupDbContext(`metricRollups.derived.${sourceTable}.${targetBucketSeconds}`, sql`
    INSERT INTO metric_rollups (
      org_id,
      source_table,
      device_id,
      metric_type,
      metric_name,
      bucket_start,
      bucket_seconds,
      avg_value,
      min_value,
      max_value,
      p95_value,
      sum_value,
      sample_count,
      gap_seconds,
      metadata
    )
    SELECT
      mr.org_id,
      mr.source_table,
      mr.device_id,
      mr.metric_type,
      mr.metric_name,
      ${targetBucketSql},
      ${targetBucketSeconds},
      (sum(mr.avg_value * mr.sample_count) / nullif(sum(mr.sample_count), 0))::double precision,
      min(mr.min_value)::double precision,
      max(mr.max_value)::double precision,
      NULL::double precision,
      sum(mr.sum_value)::double precision,
      sum(mr.sample_count)::integer,
      sum(mr.gap_seconds)::integer,
      jsonb_build_object(
        'rollupVersion', ${METRIC_ROLLUP_VERSION}::text,
        'source', 'derived',
        'sourceBucketSeconds', ${sourceBucketSeconds}::integer
      )
    FROM metric_rollups mr
    WHERE mr.org_id = ${options.orgId}
      AND mr.source_table = ${sourceTable}
      AND mr.bucket_seconds = ${sourceBucketSeconds}
      AND mr.bucket_start >= ${fromIso}::timestamp
      AND mr.bucket_start < ${toIso}::timestamp
    GROUP BY mr.org_id, mr.source_table, mr.device_id, mr.metric_type, mr.metric_name, ${targetBucketSql}
    HAVING sum(mr.sample_count) > 0
    ON CONFLICT (org_id, source_table, device_id, metric_type, metric_name, bucket_seconds, bucket_start)
    DO UPDATE SET ${upsertAssignments()}
  `);
}

/**
 * Instrumentation-only wrapper around the rollup pass (#4345). This is the real
 * "one rollup run" boundary — `jobs/metricRollups.ts` fans one of these out per
 * org every 5 minutes — so `breeze_rollup_runs_total{status}` and
 * `breeze_rollup_duration_seconds` are measured here rather than in the worker,
 * which would also count the unrelated `scan-orgs` fan-out job.
 */
export async function rollupDeviceMetricsRange(options: MetricRollupRange): Promise<MetricRollupResult> {
  const startedAt = Date.now();
  try {
    const result = await runRollupDeviceMetricsRange(options);
    recordRollupRun(result.skipped ? 'skipped' : 'success', (Date.now() - startedAt) / 1000);
    return result;
  } catch (error) {
    recordRollupRun('failure', (Date.now() - startedAt) / 1000);
    throw error;
  }
}

async function runRollupDeviceMetricsRange(options: MetricRollupRange): Promise<MetricRollupResult> {
  const { from, to } = normalizeRange(options.from, options.to);
  // The gate reads `organizations` + `partners`, both RLS-forced — with no
  // context the read returns zero rows and every org would look disabled.
  const produceOutput = await inRollupDbContext('metricRollups.mlFeatureGate', () =>
    shouldProduceMlOutput(options.orgId, 'ml.metric_rollups.enabled')
  );
  if (!produceOutput) {
    return {
      orgId: options.orgId,
      from: from.toISOString(),
      to: to.toISOString(),
      statements: 0,
      skipped: true,
    };
  }

  let statements = 0;
  for (const metric of DEVICE_METRIC_ROLLUP_SOURCES) {
    await rollupRawDeviceMetric(options, metric);
    statements += 1;
  }

  for (const metric of PROCESS_SAMPLE_ROLLUP_SOURCES) {
    await rollupRawProcessSampleMetric(options, metric);
    statements += 1;
  }

  await rollupRawSnmpMetrics(options);
  statements += 1;

  await rollupDerivedMetricSource(options, 'device_metrics', RAW_BUCKET_SECONDS, HOUR_BUCKET_SECONDS);
  statements += 1;
  await rollupDerivedMetricSource(options, 'device_metrics', HOUR_BUCKET_SECONDS, DAY_BUCKET_SECONDS);
  statements += 1;
  await rollupDerivedMetricSource(options, 'device_process_samples', RAW_BUCKET_SECONDS, HOUR_BUCKET_SECONDS);
  statements += 1;
  await rollupDerivedMetricSource(options, 'device_process_samples', HOUR_BUCKET_SECONDS, DAY_BUCKET_SECONDS);
  statements += 1;
  await rollupDerivedMetricSource(options, 'snmp_metrics', RAW_BUCKET_SECONDS, HOUR_BUCKET_SECONDS);
  statements += 1;
  await rollupDerivedMetricSource(options, 'snmp_metrics', HOUR_BUCKET_SECONDS, DAY_BUCKET_SECONDS);
  statements += 1;

  return {
    orgId: options.orgId,
    from: from.toISOString(),
    to: to.toISOString(),
    statements,
    skipped: false,
  };
}
