import { sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { shouldProduceMlOutput } from './mlFeatureFlags';

export const METRIC_ANOMALY_VERSION = 'metric-anomalies-v1';
export const METRIC_ANOMALY_V1_SHADOW_VERSION = 'metric-anomaly-v1-seasonal-robust';

const RAW_BUCKET_SECONDS = 300;
const BASELINE_LOOKBACK_HOURS = 24;
const BASELINE_GAP_MINUTES = 15;
const SEASONAL_LOOKBACK_DAYS = 28;
const SEASONAL_GAP_MINUTES = 60;
const SEASONAL_WINDOW_HOURS = 1;
const SEASONAL_MIN_BASELINE_SPAN_DAYS = 14;
const SEASONAL_MIN_BASELINE_ACTIVE_DAYS = 3;
const MIN_BASELINE_BUCKETS = 12;
const MIN_SEASONAL_BASELINE_BUCKETS = 8;
const MIN_TREND_BUCKETS = 6;

export interface MetricAnomalyRange {
  orgId: string;
  from: Date;
  to: Date;
}

export interface MetricAnomalyResult {
  orgId: string;
  from: string;
  to: string;
  statements: number;
  v1ShadowStatements?: number;
  v1ShadowSkipped?: boolean;
  skipped: boolean;
}

function normalizeRange(from: Date, to: Date): { from: Date; to: Date } {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Invalid metric anomaly range');
  }
  if (from >= to) {
    throw new Error('Metric anomaly range must have from < to');
  }
  return { from, to };
}

function anomalyUpsertAssignments(): SQL {
  return sql`
    observed_value = EXCLUDED.observed_value,
    baseline_value = EXCLUDED.baseline_value,
    baseline_min = EXCLUDED.baseline_min,
    baseline_max = EXCLUDED.baseline_max,
    score = EXCLUDED.score,
    confidence = EXCLUDED.confidence,
    sample_count = EXCLUDED.sample_count,
    baseline_summary = EXCLUDED.baseline_summary,
    evidence = EXCLUDED.evidence,
    detected_at = now(),
    updated_at = now()
  `;
}

function candidateUpsertAssignments(): SQL {
  return sql`
    observed_value = EXCLUDED.observed_value,
    baseline_value = EXCLUDED.baseline_value,
    baseline_min = EXCLUDED.baseline_min,
    baseline_max = EXCLUDED.baseline_max,
    score = EXCLUDED.score,
    confidence = EXCLUDED.confidence,
    sample_count = EXCLUDED.sample_count,
    baseline_summary = EXCLUDED.baseline_summary,
    evidence = EXCLUDED.evidence,
    detected_at = now(),
    updated_at = now()
  `;
}

async function detectBaselineDeviations(options: MetricAnomalyRange): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  // bucket_start is timestamp-without-tz; bind ISO strings + ::timestamp so the
  // comparison stays in tz-free space (matches the rollup writer) and postgres.js
  // does not bind a raw Date as timestamptz.
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  await db.execute(sql`
    WITH recent AS (
      SELECT
        mr.org_id,
        mr.device_id,
        mr.source_table,
        mr.metric_type,
        mr.metric_name,
        mr.bucket_start,
        mr.bucket_seconds,
        mr.avg_value,
        mr.sample_count
      FROM metric_rollups mr
      WHERE mr.org_id = ${options.orgId}
        AND mr.source_table = 'device_metrics'
        AND mr.bucket_seconds = ${RAW_BUCKET_SECONDS}
        AND mr.bucket_start >= ${fromIso}::timestamp
        AND mr.bucket_start < ${toIso}::timestamp
        AND mr.avg_value IS NOT NULL
        AND mr.sample_count > 0
    ),
    baseline AS (
      SELECT
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.sample_count,
        avg(b.avg_value)::double precision AS baseline_value,
        min(b.avg_value)::double precision AS baseline_min,
        max(b.avg_value)::double precision AS baseline_max,
        stddev_samp(b.avg_value)::double precision AS baseline_stddev,
        count(*)::integer AS baseline_count
      FROM recent r
      JOIN metric_rollups b
        ON b.org_id = r.org_id
       AND b.device_id = r.device_id
       AND b.source_table = r.source_table
       AND b.metric_type = r.metric_type
       AND b.metric_name = r.metric_name
       AND b.bucket_seconds = r.bucket_seconds
       AND b.avg_value IS NOT NULL
       AND b.sample_count > 0
       AND b.bucket_start >= r.bucket_start - (${BASELINE_LOOKBACK_HOURS} * interval '1 hour')
       AND b.bucket_start < r.bucket_start - (${BASELINE_GAP_MINUTES} * interval '1 minute')
      GROUP BY
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.sample_count
    ),
    scored AS (
      SELECT
        b.*,
        CASE
          WHEN b.metric_name = 'bandwidth_out_bps'
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (4 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 3, 1000000)
            THEN 'network_egress'
          WHEN b.metric_name = 'process_count'
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) + 20)
            THEN 'process_runaway'
          WHEN b.metric_name IN ('cpu_percent', 'ram_percent', 'disk_percent')
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 1.5, 90)
            THEN 'spike'
          WHEN b.metric_name IN ('disk_read_bps', 'disk_write_bps', 'bandwidth_in_bps')
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (4 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 3, 1000000)
            THEN 'spike'
          WHEN b.metric_name IN ('cpu_percent', 'ram_percent', 'disk_percent', 'process_count')
            AND coalesce(b.baseline_value, 0) >= 25
            AND b.avg_value <= least(coalesce(b.baseline_value, 0) - (3 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 0.35)
            THEN 'drop'
          ELSE NULL
        END AS anomaly_type,
        (
          abs(b.avg_value - coalesce(b.baseline_value, b.avg_value))
          / greatest(coalesce(b.baseline_stddev, 0), 1)
        )::double precision AS score
      FROM baseline b
      WHERE b.baseline_count >= ${MIN_BASELINE_BUCKETS}
    )
    INSERT INTO metric_anomalies (
      org_id,
      device_id,
      source_table,
      metric_type,
      metric_name,
      anomaly_type,
      status,
      window_start,
      window_end,
      bucket_seconds,
      observed_value,
      baseline_value,
      baseline_min,
      baseline_max,
      score,
      confidence,
      sample_count,
      baseline_summary,
      evidence
    )
    SELECT
      s.org_id,
      s.device_id,
      s.source_table,
      s.metric_type,
      s.metric_name,
      s.anomaly_type,
      'open',
      s.bucket_start,
      s.bucket_start + (${RAW_BUCKET_SECONDS} * interval '1 second'),
      s.bucket_seconds,
      s.avg_value,
      s.baseline_value,
      s.baseline_min,
      s.baseline_max,
      greatest(s.score, 0),
      least(0.99, greatest(0.5, 0.5 + (s.score / 10)))::double precision,
      s.sample_count,
      jsonb_build_object(
        'modelVersion', ${METRIC_ANOMALY_VERSION}::text,
        'baselineHours', ${BASELINE_LOOKBACK_HOURS}::integer,
        'baselineGapMinutes', ${BASELINE_GAP_MINUTES}::integer,
        'baselineBuckets', s.baseline_count,
        'baselineStddev', s.baseline_stddev
      ),
      jsonb_build_object(
        'kind', 'baseline_deviation',
        'metricName', s.metric_name,
        'observedValue', s.avg_value,
        'baselineValue', s.baseline_value
      )
    FROM scored s
    WHERE s.anomaly_type IS NOT NULL
    ON CONFLICT (org_id, device_id, metric_name, anomaly_type, bucket_seconds, window_start)
    DO UPDATE SET ${anomalyUpsertAssignments()}
    WHERE metric_anomalies.status = 'open'
  `);
}

async function detectGrowthTrends(options: MetricAnomalyRange): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  await db.execute(sql`
    WITH anchors AS (
      -- Every raw bucket in [from, to) is a potential trend-window anchor (the
      -- window end). Evaluating per-anchor — like detectBaselineDeviations — means
      -- a wide backfill/catch-up range scans every interior MIN_TREND_BUCKETS slice
      -- instead of only the single window ending at \`to\`, which silently skipped
      -- everything before to - MIN_TREND_BUCKETS*RAW_BUCKET_SECONDS.
      SELECT
        mr.org_id,
        mr.device_id,
        mr.source_table,
        mr.metric_type,
        mr.metric_name,
        mr.bucket_seconds,
        mr.bucket_start AS anchor_bucket_start
      FROM metric_rollups mr
      WHERE mr.org_id = ${options.orgId}
        AND mr.source_table = 'device_metrics'
        AND mr.bucket_seconds = ${RAW_BUCKET_SECONDS}
        AND mr.bucket_start >= ${fromIso}::timestamp
        AND mr.bucket_start < ${toIso}::timestamp
        AND mr.metric_name IN ('ram_percent', 'ram_used_mb', 'disk_percent', 'disk_used_gb')
        AND mr.avg_value IS NOT NULL
        AND mr.sample_count > 0
    ),
    recent AS (
      SELECT
        a.org_id,
        a.device_id,
        a.source_table,
        a.metric_type,
        a.metric_name,
        a.bucket_seconds,
        min(w.bucket_start) AS window_start,
        max(w.bucket_start) AS last_bucket_start,
        count(*)::integer AS bucket_count,
        (array_agg(w.avg_value ORDER BY w.bucket_start ASC))[1]::double precision AS first_value,
        (array_agg(w.avg_value ORDER BY w.bucket_start DESC))[1]::double precision AS last_value,
        min(w.avg_value)::double precision AS min_value,
        max(w.avg_value)::double precision AS max_value,
        sum(w.sample_count)::integer AS sample_count
      FROM anchors a
      JOIN metric_rollups w
        ON w.org_id = a.org_id
       AND w.device_id = a.device_id
       AND w.source_table = a.source_table
       AND w.metric_type = a.metric_type
       AND w.metric_name = a.metric_name
       AND w.bucket_seconds = a.bucket_seconds
       AND w.avg_value IS NOT NULL
       AND w.sample_count > 0
       AND w.bucket_start > a.anchor_bucket_start - (${MIN_TREND_BUCKETS}::integer * ${RAW_BUCKET_SECONDS}::integer * interval '1 second')
       AND w.bucket_start <= a.anchor_bucket_start
      GROUP BY
        a.org_id,
        a.device_id,
        a.source_table,
        a.metric_type,
        a.metric_name,
        a.bucket_seconds,
        a.anchor_bucket_start
    ),
    trend AS (
      SELECT
        r.*,
        CASE
          WHEN r.metric_name IN ('ram_percent', 'ram_used_mb') THEN 'memory_growth'
          WHEN r.metric_name IN ('disk_percent', 'disk_used_gb') THEN 'disk_growth'
          ELSE 'trend'
        END AS anomaly_type,
        greatest(r.last_value - r.first_value, 0)::double precision AS score
      FROM recent r
      WHERE r.bucket_count >= ${MIN_TREND_BUCKETS}
        AND r.last_value > r.first_value
        AND (
          (r.metric_name IN ('ram_percent', 'disk_percent') AND r.last_value - r.first_value >= 15)
          OR (r.metric_name = 'ram_used_mb' AND r.last_value >= r.first_value * 1.25 AND r.last_value - r.first_value >= 512)
          OR (r.metric_name = 'disk_used_gb' AND r.last_value >= r.first_value * 1.10 AND r.last_value - r.first_value >= 5)
        )
    )
    INSERT INTO metric_anomalies (
      org_id,
      device_id,
      source_table,
      metric_type,
      metric_name,
      anomaly_type,
      status,
      window_start,
      window_end,
      bucket_seconds,
      observed_value,
      baseline_value,
      baseline_min,
      baseline_max,
      score,
      confidence,
      sample_count,
      baseline_summary,
      evidence
    )
    SELECT
      t.org_id,
      t.device_id,
      t.source_table,
      t.metric_type,
      t.metric_name,
      t.anomaly_type,
      'open',
      t.window_start,
      t.last_bucket_start + (${RAW_BUCKET_SECONDS} * interval '1 second'),
      t.bucket_seconds,
      t.last_value,
      t.first_value,
      t.min_value,
      t.max_value,
      t.score,
      least(0.98, greatest(0.55, 0.55 + (t.score / 100)))::double precision,
      t.sample_count,
      jsonb_build_object(
        'modelVersion', ${METRIC_ANOMALY_VERSION}::text,
        'trendBuckets', t.bucket_count,
        'firstValue', t.first_value,
        'lastValue', t.last_value
      ),
      jsonb_build_object(
        'kind', 'growth_trend',
        'metricName', t.metric_name,
        'observedValue', t.last_value,
        'startingValue', t.first_value
      )
    FROM trend t
    ON CONFLICT (org_id, device_id, metric_name, anomaly_type, bucket_seconds, window_start)
    DO UPDATE SET ${anomalyUpsertAssignments()}
    WHERE metric_anomalies.status = 'open'
  `);
}

async function detectProcessSampleRunaways(options: MetricAnomalyRange): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  await db.execute(sql`
    WITH recent AS (
      SELECT
        mr.org_id,
        mr.device_id,
        mr.source_table,
        mr.metric_type,
        mr.metric_name,
        mr.bucket_start,
        mr.bucket_seconds,
        mr.avg_value,
        mr.max_value,
        mr.sample_count
      FROM metric_rollups mr
      WHERE mr.org_id = ${options.orgId}
        AND mr.source_table = 'device_process_samples'
        AND mr.bucket_seconds = ${RAW_BUCKET_SECONDS}
        AND mr.bucket_start >= ${fromIso}::timestamp
        AND mr.bucket_start < ${toIso}::timestamp
        AND mr.metric_name IN (
          'top_process_cpu_percent_sum',
          'top_process_cpu_percent_max',
          'top_process_ram_mb_sum',
          'top_process_ram_mb_max',
          'top_process_disk_bps_sum',
          'top_process_net_bps_sum'
        )
        AND mr.avg_value IS NOT NULL
        AND mr.sample_count > 0
    ),
    baseline AS (
      SELECT
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.max_value,
        r.sample_count,
        avg(b.avg_value)::double precision AS baseline_value,
        min(b.avg_value)::double precision AS baseline_min,
        max(b.avg_value)::double precision AS baseline_max,
        stddev_samp(b.avg_value)::double precision AS baseline_stddev,
        count(*)::integer AS baseline_count
      FROM recent r
      JOIN metric_rollups b
        ON b.org_id = r.org_id
       AND b.device_id = r.device_id
       AND b.source_table = r.source_table
       AND b.metric_type = r.metric_type
       AND b.metric_name = r.metric_name
       AND b.bucket_seconds = r.bucket_seconds
       AND b.avg_value IS NOT NULL
       AND b.sample_count > 0
       AND b.bucket_start >= r.bucket_start - (${BASELINE_LOOKBACK_HOURS} * interval '1 hour')
       AND b.bucket_start < r.bucket_start - (${BASELINE_GAP_MINUTES} * interval '1 minute')
      GROUP BY
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.max_value,
        r.sample_count
    ),
    scored AS (
      SELECT
        b.*,
        (
          abs(b.avg_value - coalesce(b.baseline_value, b.avg_value))
          / greatest(coalesce(b.baseline_stddev, 0), 1)
        )::double precision AS score
      FROM baseline b
      WHERE b.baseline_count >= ${MIN_BASELINE_BUCKETS}
        AND (
          (
            b.metric_name IN ('top_process_cpu_percent_sum', 'top_process_cpu_percent_max')
            AND b.avg_value >= greatest(
              coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)),
              coalesce(b.baseline_value, 0) * 2,
              80
            )
          )
          OR (
            b.metric_name IN ('top_process_ram_mb_sum', 'top_process_ram_mb_max')
            AND b.avg_value >= greatest(
              coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)),
              coalesce(b.baseline_value, 0) * 1.75,
              1024
            )
          )
          OR (
            b.metric_name IN ('top_process_disk_bps_sum', 'top_process_net_bps_sum')
            AND b.avg_value >= greatest(
              coalesce(b.baseline_value, 0) + (4 * greatest(coalesce(b.baseline_stddev, 0), 1)),
              coalesce(b.baseline_value, 0) * 3,
              1000000
            )
          )
        )
    )
    INSERT INTO metric_anomalies (
      org_id,
      device_id,
      source_table,
      metric_type,
      metric_name,
      anomaly_type,
      status,
      window_start,
      window_end,
      bucket_seconds,
      observed_value,
      baseline_value,
      baseline_min,
      baseline_max,
      score,
      confidence,
      sample_count,
      baseline_summary,
      evidence
    )
    SELECT
      s.org_id,
      s.device_id,
      s.source_table,
      s.metric_type,
      s.metric_name,
      CASE
        WHEN s.metric_name = 'top_process_net_bps_sum' THEN 'network_egress'
        ELSE 'process_runaway'
      END,
      'open',
      s.bucket_start,
      s.bucket_start + (${RAW_BUCKET_SECONDS} * interval '1 second'),
      s.bucket_seconds,
      s.avg_value,
      s.baseline_value,
      s.baseline_min,
      s.baseline_max,
      greatest(s.score, 0),
      least(0.99, greatest(0.55, 0.55 + (s.score / 10)))::double precision,
      s.sample_count,
      jsonb_build_object(
        'modelVersion', ${METRIC_ANOMALY_VERSION}::text,
        'baselineHours', ${BASELINE_LOOKBACK_HOURS}::integer,
        'baselineGapMinutes', ${BASELINE_GAP_MINUTES}::integer,
        'baselineBuckets', s.baseline_count,
        'baselineStddev', s.baseline_stddev,
        'sourceTable', s.source_table
      ),
      jsonb_build_object(
        'kind', 'process_sample_runaway',
        'metricName', s.metric_name,
        'observedValue', s.avg_value,
        'baselineValue', s.baseline_value,
        'baselineMax', s.baseline_max
      )
    FROM scored s
    ON CONFLICT (org_id, device_id, metric_name, anomaly_type, bucket_seconds, window_start)
    DO UPDATE SET ${anomalyUpsertAssignments()}
    WHERE metric_anomalies.status = 'open'
  `);
}

async function detectSeasonalRobustCandidates(options: MetricAnomalyRange): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  await db.execute(sql`
    WITH recent AS (
      SELECT
        mr.org_id,
        mr.device_id,
        mr.source_table,
        mr.metric_type,
        mr.metric_name,
        mr.bucket_start,
        mr.bucket_seconds,
        mr.avg_value,
        mr.sample_count,
        ((extract(dow from mr.bucket_start)::integer * 24) + extract(hour from mr.bucket_start)::integer) AS hour_of_week
      FROM metric_rollups mr
      WHERE mr.org_id = ${options.orgId}
        AND mr.source_table IN ('device_metrics', 'device_process_samples')
        AND mr.bucket_seconds = ${RAW_BUCKET_SECONDS}
        AND mr.bucket_start >= ${fromIso}::timestamp
        AND mr.bucket_start < ${toIso}::timestamp
        AND mr.metric_name IN (
          'cpu_percent',
          'ram_percent',
          'disk_percent',
          'ram_used_mb',
          'disk_used_gb',
          'disk_read_bps',
          'disk_write_bps',
          'bandwidth_in_bps',
          'bandwidth_out_bps',
          'process_count',
          'top_process_cpu_percent_sum',
          'top_process_cpu_percent_max',
          'top_process_ram_mb_sum',
          'top_process_ram_mb_max',
          'top_process_disk_bps_sum',
          'top_process_net_bps_sum'
        )
        AND mr.avg_value IS NOT NULL
        AND mr.sample_count > 0
    ),
    baseline_values AS (
      SELECT
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value AS observed_value,
        r.sample_count AS observed_sample_count,
        b.bucket_start AS baseline_bucket_start,
        b.avg_value AS baseline_sample_value,
        b.sample_count AS baseline_sample_count
      FROM recent r
      JOIN metric_rollups b
        ON b.org_id = r.org_id
       AND b.device_id = r.device_id
       AND b.source_table = r.source_table
       AND b.metric_type = r.metric_type
       AND b.metric_name = r.metric_name
       AND b.bucket_seconds = r.bucket_seconds
       AND b.avg_value IS NOT NULL
       AND b.sample_count > 0
       AND b.bucket_start >= r.bucket_start - (${SEASONAL_LOOKBACK_DAYS}::integer * interval '1 day')
       AND b.bucket_start < r.bucket_start - (${SEASONAL_GAP_MINUTES}::integer * interval '1 minute')
       AND least(
         abs(((extract(dow from b.bucket_start)::integer * 24) + extract(hour from b.bucket_start)::integer) - r.hour_of_week),
         168 - abs(((extract(dow from b.bucket_start)::integer * 24) + extract(hour from b.bucket_start)::integer) - r.hour_of_week)
       ) <= ${SEASONAL_WINDOW_HOURS}
    ),
    baseline_stats AS (
      SELECT
        bv.org_id,
        bv.device_id,
        bv.source_table,
        bv.metric_type,
        bv.metric_name,
        bv.bucket_start,
        bv.bucket_seconds,
        bv.observed_value,
        bv.observed_sample_count,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY bv.baseline_sample_value))::double precision AS median_value,
        (percentile_cont(0.25) WITHIN GROUP (ORDER BY bv.baseline_sample_value))::double precision AS q1_value,
        (percentile_cont(0.75) WITHIN GROUP (ORDER BY bv.baseline_sample_value))::double precision AS q3_value,
        min(bv.baseline_sample_value)::double precision AS baseline_min,
        max(bv.baseline_sample_value)::double precision AS baseline_max,
        min(bv.baseline_bucket_start) AS baseline_first_bucket,
        max(bv.baseline_bucket_start) AS baseline_last_bucket,
        count(DISTINCT bv.baseline_bucket_start::date)::integer AS baseline_active_days,
        count(*)::integer AS baseline_count,
        sum(bv.baseline_sample_count)::integer AS baseline_sample_count
      FROM baseline_values bv
      GROUP BY
        bv.org_id,
        bv.device_id,
        bv.source_table,
        bv.metric_type,
        bv.metric_name,
        bv.bucket_start,
        bv.bucket_seconds,
        bv.observed_value,
        bv.observed_sample_count
    ),
    baseline_deviations AS (
      SELECT
        bs.org_id,
        bs.device_id,
        bs.source_table,
        bs.metric_type,
        bs.metric_name,
        bs.bucket_start,
        bs.bucket_seconds,
        abs(bv.baseline_sample_value - bs.median_value) AS deviation
      FROM baseline_stats bs
      JOIN baseline_values bv
        ON bv.org_id = bs.org_id
       AND bv.device_id = bs.device_id
       AND bv.source_table = bs.source_table
       AND bv.metric_type = bs.metric_type
       AND bv.metric_name = bs.metric_name
       AND bv.bucket_start = bs.bucket_start
       AND bv.bucket_seconds = bs.bucket_seconds
    ),
    baseline_mad AS (
      SELECT
        bd.org_id,
        bd.device_id,
        bd.source_table,
        bd.metric_type,
        bd.metric_name,
        bd.bucket_start,
        bd.bucket_seconds,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY bd.deviation))::double precision AS mad_value
      FROM baseline_deviations bd
      GROUP BY
        bd.org_id,
        bd.device_id,
        bd.source_table,
        bd.metric_type,
        bd.metric_name,
        bd.bucket_start,
        bd.bucket_seconds
    ),
    scored_base AS (
      SELECT
        bs.*,
        bm.mad_value,
        (
          extract(epoch from (bs.baseline_last_bucket - bs.baseline_first_bucket)) / 86400.0
        )::double precision AS baseline_span_days,
        greatest(
          coalesce(bm.mad_value, 0) * 1.4826,
          coalesce((bs.q3_value - bs.q1_value) / 1.349, 0),
          1
        )::double precision AS robust_spread
      FROM baseline_stats bs
      JOIN baseline_mad bm
        ON bm.org_id = bs.org_id
       AND bm.device_id = bs.device_id
       AND bm.source_table = bs.source_table
       AND bm.metric_type = bs.metric_type
       AND bm.metric_name = bs.metric_name
       AND bm.bucket_start = bs.bucket_start
       AND bm.bucket_seconds = bs.bucket_seconds
      WHERE bs.baseline_count >= ${MIN_SEASONAL_BASELINE_BUCKETS}
        AND bs.baseline_active_days >= ${SEASONAL_MIN_BASELINE_ACTIVE_DAYS}
        AND bs.baseline_first_bucket <= bs.bucket_start - (${SEASONAL_MIN_BASELINE_SPAN_DAYS}::integer * interval '1 day')
    ),
    scored AS (
      SELECT
        sb.*,
        (abs(sb.observed_value - sb.median_value) / sb.robust_spread)::double precision AS score
      FROM scored_base sb
    ),
    candidates AS (
      SELECT
        s.*,
        CASE
          WHEN s.metric_name IN ('bandwidth_out_bps', 'top_process_net_bps_sum')
            AND s.observed_value >= greatest(s.median_value + (4 * s.robust_spread), s.median_value * 2.5, 1000000)
            THEN 'network_egress'
          WHEN s.metric_name IN (
              'process_count',
              'top_process_cpu_percent_sum',
              'top_process_cpu_percent_max',
              'top_process_ram_mb_sum',
              'top_process_ram_mb_max',
              'top_process_disk_bps_sum'
            )
            AND s.observed_value >= greatest(s.median_value + (4 * s.robust_spread), s.median_value * 1.75, 80)
            THEN 'process_runaway'
          WHEN s.metric_name IN ('cpu_percent', 'ram_percent', 'disk_percent')
            AND s.observed_value >= greatest(s.median_value + (4 * s.robust_spread), s.median_value * 1.35, 90)
            THEN 'spike'
          WHEN s.metric_name IN ('ram_used_mb', 'disk_used_gb')
            AND s.observed_value >= greatest(s.median_value + (4 * s.robust_spread), s.median_value * 1.35)
            THEN 'spike'
          WHEN s.metric_name IN ('disk_read_bps', 'disk_write_bps', 'bandwidth_in_bps')
            AND s.observed_value >= greatest(s.median_value + (4 * s.robust_spread), s.median_value * 2.5, 1000000)
            THEN 'spike'
          WHEN s.metric_name IN ('cpu_percent', 'ram_percent', 'disk_percent', 'process_count')
            AND s.median_value >= 25
            AND s.observed_value <= least(s.median_value - (4 * s.robust_spread), s.median_value * 0.4)
            THEN 'drop'
          ELSE NULL
        END AS anomaly_type
      FROM scored s
      WHERE s.score >= 4
    )
    INSERT INTO metric_anomaly_candidates (
      org_id,
      device_id,
      source_table,
      metric_type,
      metric_name,
      model_version,
      anomaly_type,
      window_start,
      window_end,
      bucket_seconds,
      observed_value,
      baseline_value,
      baseline_min,
      baseline_max,
      score,
      confidence,
      sample_count,
      baseline_summary,
      evidence
    )
    SELECT
      c.org_id,
      c.device_id,
      c.source_table,
      c.metric_type,
      c.metric_name,
      ${METRIC_ANOMALY_V1_SHADOW_VERSION}::text,
      c.anomaly_type,
      c.bucket_start,
      c.bucket_start + (${RAW_BUCKET_SECONDS} * interval '1 second'),
      c.bucket_seconds,
      c.observed_value,
      c.median_value,
      c.baseline_min,
      c.baseline_max,
      greatest(c.score, 0),
      least(0.99, greatest(0.55, 0.55 + (c.score / 12)))::double precision,
      c.observed_sample_count,
      jsonb_build_object(
        'modelVersion', ${METRIC_ANOMALY_V1_SHADOW_VERSION}::text,
        'baselineDays', ${SEASONAL_LOOKBACK_DAYS}::integer,
        'baselineGapMinutes', ${SEASONAL_GAP_MINUTES}::integer,
        'seasonalWindowHours', ${SEASONAL_WINDOW_HOURS}::integer,
        'readinessState', 'ready',
        'minBaselineSpanDays', ${SEASONAL_MIN_BASELINE_SPAN_DAYS}::integer,
        'minBaselineActiveDays', ${SEASONAL_MIN_BASELINE_ACTIVE_DAYS}::integer,
        'baselineBuckets', c.baseline_count,
        'baselineActiveDays', c.baseline_active_days,
        'baselineSpanDays', c.baseline_span_days,
        'baselineFirstBucket', c.baseline_first_bucket,
        'baselineLastBucket', c.baseline_last_bucket,
        'baselineSampleCount', c.baseline_sample_count,
        'median', c.median_value,
        'q1', c.q1_value,
        'q3', c.q3_value,
        'mad', c.mad_value,
        'robustSpread', c.robust_spread
      ),
      jsonb_build_object(
        'kind', 'seasonal_robust_deviation',
        'metricName', c.metric_name,
        'observedValue', c.observed_value,
        'baselineValue', c.median_value,
        'score', c.score
      )
    FROM candidates c
    WHERE c.anomaly_type IS NOT NULL
    ON CONFLICT (org_id, device_id, source_table, metric_name, anomaly_type, model_version, bucket_seconds, window_start)
    DO UPDATE SET ${candidateUpsertAssignments()}
  `);
}

export async function detectMetricAnomaliesRange(options: MetricAnomalyRange): Promise<MetricAnomalyResult> {
  const { from, to } = normalizeRange(options.from, options.to);
  if (!(await shouldProduceMlOutput(options.orgId, 'ml.anomalies.enabled'))) {
    return {
      orgId: options.orgId,
      from: from.toISOString(),
      to: to.toISOString(),
      statements: 0,
      skipped: true,
    };
  }

  await detectBaselineDeviations(options);
  await detectGrowthTrends(options);
  await detectProcessSampleRunaways(options);

  const runV1Shadow = await shouldProduceMlOutput(options.orgId, 'ml.anomalies.v1_shadow.enabled');
  if (runV1Shadow) {
    await detectSeasonalRobustCandidates(options);
  }

  return {
    orgId: options.orgId,
    from: from.toISOString(),
    to: to.toISOString(),
    statements: 3,
    v1ShadowStatements: runV1Shadow ? 1 : 0,
    v1ShadowSkipped: !runV1Shadow,
    skipped: false,
  };
}
