import { sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { shouldProduceMlOutput } from './mlFeatureFlags';

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
  return sql<Date>`to_timestamp(floor(extract(epoch from ${timestampSql}) / ${bucketSeconds}) * ${bucketSeconds})::timestamp`;
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

async function rollupRawDeviceMetric(options: MetricRollupRange, metric: (typeof DEVICE_METRIC_ROLLUP_SOURCES)[number]): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const expectedSampleSeconds = options.expectedSampleSeconds ?? DEFAULT_EXPECTED_SAMPLE_SECONDS;
  const valueSql = sql.raw(`dm.${metric.column}`);

  await db.execute(sql`
    WITH metric_devices AS (
      SELECT DISTINCT dm.org_id, dm.device_id
      FROM device_metrics dm
      WHERE dm.org_id = ${options.orgId}
        AND dm.timestamp >= ${from}
        AND dm.timestamp < ${to}
        AND ${valueSql} IS NOT NULL
    ),
    buckets AS (
      SELECT generate_series(
        ${from}::timestamp,
        ${to}::timestamp - interval '1 second' * ${RAW_BUCKET_SECONDS},
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
        'rollupVersion', ${METRIC_ROLLUP_VERSION},
        'source', 'raw',
        'expectedSampleSeconds', ${expectedSampleSeconds},
        'isGap', count(${valueSql}) = 0
      )
    FROM bucket_grid bg
    LEFT JOIN device_metrics dm
      ON dm.org_id = bg.org_id
      AND dm.device_id = bg.device_id
      AND dm.timestamp >= bg.bucket_start
      AND dm.timestamp < bg.bucket_start + (interval '1 second' * ${RAW_BUCKET_SECONDS})
      AND ${valueSql} IS NOT NULL
    GROUP BY bg.org_id, bg.device_id, bg.bucket_start
    ON CONFLICT (org_id, source_table, device_id, metric_type, metric_name, bucket_seconds, bucket_start)
    DO UPDATE SET ${upsertAssignments()}
  `);
}

async function rollupDerivedDeviceMetrics(options: MetricRollupRange, sourceBucketSeconds: MetricRollupBucketSeconds, targetBucketSeconds: MetricRollupBucketSeconds): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const targetBucketSql = bucketStartSql(sql`mr.bucket_start`, targetBucketSeconds);

  await db.execute(sql`
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
      jsonb_build_object('rollupVersion', ${METRIC_ROLLUP_VERSION}, 'source', 'derived', 'sourceBucketSeconds', ${sourceBucketSeconds})
    FROM metric_rollups mr
    WHERE mr.org_id = ${options.orgId}
      AND mr.source_table = 'device_metrics'
      AND mr.bucket_seconds = ${sourceBucketSeconds}
      AND mr.bucket_start >= ${from}
      AND mr.bucket_start < ${to}
    GROUP BY mr.org_id, mr.source_table, mr.device_id, mr.metric_type, mr.metric_name, ${targetBucketSql}
    HAVING sum(mr.sample_count) > 0
    ON CONFLICT (org_id, source_table, device_id, metric_type, metric_name, bucket_seconds, bucket_start)
    DO UPDATE SET ${upsertAssignments()}
  `);
}

export async function rollupDeviceMetricsRange(options: MetricRollupRange): Promise<MetricRollupResult> {
  const { from, to } = normalizeRange(options.from, options.to);
  if (!(await shouldProduceMlOutput(options.orgId, 'ml.metric_rollups.enabled'))) {
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

  await rollupDerivedDeviceMetrics(options, RAW_BUCKET_SECONDS, HOUR_BUCKET_SECONDS);
  statements += 1;
  await rollupDerivedDeviceMetrics(options, HOUR_BUCKET_SECONDS, DAY_BUCKET_SECONDS);
  statements += 1;

  return {
    orgId: options.orgId,
    from: from.toISOString(),
    to: to.toISOString(),
    statements,
    skipped: false,
  };
}
