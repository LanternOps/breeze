import { sql, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tightenLockTimeout, tightenStatementTimeout } from '../db/lockTimeout';
import { pgErrorCode } from '../utils/pgErrors';
import { captureMessage } from './sentry';
import { shouldProduceMlOutput, type MlFeatureFlagName } from './mlFeatureFlags';

export const METRIC_ANOMALY_VERSION = 'metric-anomalies-v1';
export const METRIC_ANOMALY_V1_SHADOW_VERSION = 'metric-anomaly-v1-seasonal-robust';

/**
 * Advisory-lock namespace for per-org anomaly detection (#5283).
 *
 * The two-int form of `pg_try_advisory_xact_lock` is deliberate: the sibling
 * worker on the same table (`metricRollupMaintenance.tryAcquireMaintenanceLock`)
 * takes the SINGLE-int `pg_try_advisory_lock(hashtext(...))`, and single-int and
 * two-int advisory locks live in the same 64-bit key space — a one-arg
 * `hashtext()` that happened to equal our packed pair would collide across two
 * unrelated subsystems. Namespacing the org hash keeps the two disjoint.
 */
export const METRIC_ANOMALY_LOCK_NAMESPACE = 5283;

/**
 * Per-detector wait bounds (#5283).
 *
 * `lock_timeout` bounds each individual lock ACQUISITION, `statement_timeout`
 * bounds the whole statement — both are needed, because a detector's upsert
 * touches many rows and a run of staggered blockers would otherwise buy a fresh
 * `lock_timeout` interval per row (see `db/lockTimeout`). Without these, the
 * production incident held one pooled connection in a `Lock` wait for 29+
 * minutes. A detector that trips either bound is skipped for this tick rather
 * than crashing the worker; the next tick re-covers the window.
 */
export const METRIC_ANOMALY_LOCK_TIMEOUT_MS = 30_000;
export const METRIC_ANOMALY_STATEMENT_TIMEOUT_MS = 90_000;

/**
 * The ordered detection stages. Each runs in its OWN transaction (#5283): the
 * whole run used to share one, so a second run's `ON CONFLICT` upsert waited on
 * the first run's *transactionid* for the duration of all four statements
 * instead of just the one it actually conflicted with.
 */
export const METRIC_ANOMALY_STAGES = [
  'baseline',
  'growth-trend',
  'process-runaway',
  'incidents',
  'v1-shadow',
] as const;
export type MetricAnomalyStage = (typeof METRIC_ANOMALY_STAGES)[number];

/**
 * - `completed` — the stage's statement committed.
 * - `locked`    — another run for this org held the advisory lock. Not an
 *                 error: the concurrent run is covering an overlapping window.
 * - `timeout`   — the stage hit `lock_timeout` (55P03) or `statement_timeout`
 *                 (57014) and was rolled back. Nothing was written.
 */
export type MetricAnomalyStageOutcome = 'completed' | 'locked' | 'timeout';

export interface MetricAnomalyStageResult {
  stage: MetricAnomalyStage;
  outcome: MetricAnomalyStageOutcome;
  durationMs: number;
  /** Postgres SQLSTATE for a `timeout` outcome; absent otherwise. */
  sqlState?: string;
}

export type MetricAnomalySkipReason = 'ml-disabled' | 'locked' | 'timeout';

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
  /** Non-shadow stages that actually committed (was a hardcoded 4 before #5283). */
  statements: number;
  v1ShadowStatements?: number;
  v1ShadowSkipped?: boolean;
  /**
   * True when the run wrote NOTHING. Before #5283 that could only mean
   * "ml.anomalies.enabled is off"; it now also covers a lock-contended or
   * timed-out run, so read `skippedReason` rather than assuming the flag.
   */
  skipped: boolean;
  skippedReason?: MetricAnomalySkipReason;
  /**
   * Per-stage outcomes, in execution order. A run where some stages committed
   * and others were `locked`/`timeout` reports `skipped: false` with a short
   * `stages` array — that partial coverage is only legible here.
   */
  stages: MetricAnomalyStageResult[];
}

/**
 * Try to claim this org's detection slot for the CURRENT transaction.
 *
 * `pg_try_advisory_xact_lock` never waits, so a second run returns false
 * immediately instead of joining the queue behind the first — which is the
 * whole point: the incident in #5283 was runs piling up in a `Lock` wait, not
 * runs being slow. The lock releases at commit/rollback, so it scopes to
 * exactly one stage.
 */
async function tryAcquireOrgDetectionLock(orgId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT pg_try_advisory_xact_lock(${METRIC_ANOMALY_LOCK_NAMESPACE}, hashtext(${orgId})) AS "acquired"
  `);
  const row = Array.isArray(result) ? (result[0] as { acquired?: unknown } | undefined) : undefined;
  return row?.acquired === true;
}

/**
 * Consecutive non-`completed` outcomes per (org, stage).
 *
 * One skip is expected and self-healing — a backfill raced the cron, or a
 * detector lost a lock race. A RUN of them is not: a detector that is
 * permanently too slow for its `statement_timeout`, or an org whose lock is
 * held by something stuck, would otherwise skip on every tick forever behind
 * nothing but a `console.warn`. That is the same invisible-degradation shape as
 * the incident this fixes, so it escalates to Sentry.
 *
 * Entries are deleted on success, so the map is bounded by the set of
 * CURRENTLY failing (org, stage) pairs rather than by fleet size.
 */
const consecutiveSkipsByOrgStage = new Map<string, number>();
const METRIC_ANOMALY_STALL_ALERT_AFTER = 3;

/** TEST ONLY — clears the consecutive-skip counters between cases. */
export function __resetMetricAnomalyStallTracking(): void {
  consecutiveSkipsByOrgStage.clear();
}

function recordStageOutcome(result: MetricAnomalyStageResult, orgId: string): void {
  const key = `${orgId}:${result.stage}`;
  if (result.outcome === 'completed') {
    consecutiveSkipsByOrgStage.delete(key);
    return;
  }

  const consecutive = (consecutiveSkipsByOrgStage.get(key) ?? 0) + 1;
  consecutiveSkipsByOrgStage.set(key, consecutive);

  // Fire on the threshold and then once per further N, so a permanently stuck
  // stage reports roughly every 30 minutes at the 10-minute cron rather than on
  // every tick. `scrubEvent` strips the message, so the tags carry the payload —
  // `pg_code` is what separates an administrative `pg_cancel_backend` (57014,
  // arriving once) from a genuine statement_timeout or lock_timeout regression.
  if (consecutive % METRIC_ANOMALY_STALL_ALERT_AFTER !== 0) return;
  captureMessage(
    `Metric anomaly stage skipped ${consecutive} consecutive runs`,
    {
      eventCode: 'metric_anomaly_stage_stalled',
      level: 'warning',
      tags: {
        org_id: orgId,
        metric_anomaly_stage: result.stage,
        ...(result.sqlState ? { pg_code: result.sqlState } : {}),
      },
    },
  );
}

/**
 * Run one detection stage in its own system-scoped transaction, under the
 * per-org advisory lock and bounded wait timeouts.
 *
 * `runOutsideDbContext` is load-bearing, not defensive: `withDbAccessContext`
 * early-returns into an ambient context, so a caller that still wrapped the
 * whole run (the CLI backfill did) would silently collapse all five stages back
 * into ONE transaction — reintroducing the exact bug. Exiting the ambient store
 * first guarantees a genuinely fresh transaction per stage regardless of caller.
 *
 * The timeout catch sits OUTSIDE the transaction callback on purpose: a 55P03 /
 * 57014 aborts the transaction, so any statement issued after it inside the
 * callback would fail 25P02 and mask the real cause. By the time we catch here,
 * drizzle has rolled back and the connection is clean for the next stage.
 */
async function runDetectionStage(
  stage: MetricAnomalyStage,
  orgId: string,
  run: () => Promise<void>,
): Promise<MetricAnomalyStageResult> {
  const startedAt = Date.now();
  try {
    const outcome = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async (): Promise<MetricAnomalyStageOutcome> => {
        if (!(await tryAcquireOrgDetectionLock(orgId))) return 'locked';
        // Never restored: this transaction ends with the stage, so `SET LOCAL`
        // dies with it. Both helpers only ever tighten, so a caller that
        // already set something stricter keeps its own bound.
        await tightenLockTimeout(db, METRIC_ANOMALY_LOCK_TIMEOUT_MS);
        await tightenStatementTimeout(db, METRIC_ANOMALY_STATEMENT_TIMEOUT_MS);
        await run();
        return 'completed';
      }, `metricAnomalies.${stage}`),
    );

    if (outcome === 'locked') {
      // Info, not warn: with a stable per-org scheduled job id this only
      // happens when a manual backfill races the cron, and the winner is
      // covering an overlapping window. Skipping is the designed behaviour.
      console.info(
        `[MetricAnomalies] org=${orgId} stage=${stage} skipped — another detection run holds the org advisory lock`,
      );
    }
    const result: MetricAnomalyStageResult = { stage, outcome, durationMs: Date.now() - startedAt };
    recordStageOutcome(result, orgId);
    return result;
  } catch (error) {
    const sqlState = pgErrorCode(error);
    // 55P03 = lock_not_available (our `lock_timeout`), 57014 = query_canceled
    // (our `statement_timeout`, or an administrative cancel — the code does not
    // distinguish, and the response is the same either way). Both mean this
    // stage wrote nothing and rolled back cleanly, so the run continues.
    // Anything else is a real fault and must fail the job.
    if (sqlState === '55P03' || sqlState === '57014') {
      console.warn(
        `[MetricAnomalies] org=${orgId} stage=${stage} exceeded its wait bound `
          + `(SQLSTATE ${sqlState}) after ${Date.now() - startedAt}ms — skipped for this tick`,
      );
      const result: MetricAnomalyStageResult = {
        stage,
        outcome: 'timeout',
        sqlState,
        durationMs: Date.now() - startedAt,
      };
      recordStageOutcome(result, orgId);
      return result;
    }
    throw error;
  }
}

/**
 * Read one ML flag in its own short system context.
 *
 * `loadMlFlagInputs` reads `organizations` in the CALLER'S RLS context by
 * design (#2822), so a contextless read matches zero rows and resolves the flag
 * to `org_not_found` → disabled. Splitting the per-stage transactions out of the
 * old single outer `withSystemDbAccessContext` therefore has to keep an explicit
 * system context here, or anomaly detection would silently stop for every org
 * with no error anywhere.
 */
async function readMlFlag(orgId: string, flag: MlFeatureFlagName): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => shouldProduceMlOutput(orgId, flag), 'metricAnomalies.flags'),
  );
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

/**
 * Wave 6 PR 4 (#3828) Task 2 — the incident row IS the transactional dispatch
 * outbox (see `metricAnomalyIncidents.ts`'s file header): `dispatched_at`,
 * `dispatch_attempts`, and `agent_run_id` ARE the dispatch marker, and this
 * SET list deliberately never assigns any of them. That omission — not
 * publisher-side bookkeeping — is what makes a bulk detector re-upsert
 * publish-inert by construction: the marker set by the Task 2 publisher can
 * never be clobbered back to NULL by this statement, no matter how many
 * times the same org/range is re-detected (the 10-min schedule over a
 * 30-min lookback revisits every row ~3x by design). `first_seen_at` is
 * likewise never refreshed, so it stays pinned to the incident's original
 * first-detected timestamp across every subsequent pass.
 */
function incidentUpsertAssignments(): SQL {
  return sql`
    last_seen_at = EXCLUDED.last_seen_at,
    peak_score = GREATEST(metric_anomaly_incidents.peak_score, EXCLUDED.peak_score),
    row_count = EXCLUDED.row_count,
    metric_names = EXCLUDED.metric_names
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

/**
 * Wave 6 PR 4 (#3828) Task 2 — after the three per-row detectors above have
 * run for this org/range, collapse the `metric_anomalies` rows they just
 * touched into their canonical `metric_anomaly_incidents` row(s).
 *
 * Collapsing key matches `metric_anomaly_incidents`' unique index exactly:
 * `(org_id, device_id, anomaly_type, bucket_seconds, window_start)` —
 * `metric_name` deliberately excluded from GROUP BY and the conflict target,
 * mirroring `metricAnomalyPromotion.ts`'s `findDedupeSiblings` (it still
 * appears folded into `array_agg(DISTINCT metric_name)`, listing every
 * sibling metric name the incident collapses).
 *
 * Filtered on `ma.window_end >= $1`, NOT `ma.window_start` — a growth-trend
 * row's `window_start` is the START of its multi-bucket trend window and can
 * predate this pass's `from` (the trend CTE looks up to `MIN_TREND_BUCKETS`
 * buckets before its anchor), so filtering on `window_start >= from` would
 * exclude every growth-trend row whose anchor lands in the first
 * `MIN_TREND_BUCKETS * RAW_BUCKET_SECONDS` of the range — which, given the
 * cron's `to - from` spacing, is every anchor except the single bucket
 * nearest `to`. `window_end` (`last_bucket_start + RAW_BUCKET_SECONDS` for
 * growth trends, always `bucket_start + RAW_BUCKET_SECONDS` for the other
 * two detectors) is always `>= from` for any row this pass just wrote, since
 * every detector's own bucket-selection CTE already requires
 * `bucket_start >= from`. There is deliberately no upper bound against `to`:
 * an incident can keep collapsing across later revisit passes rather than
 * falling out of range once its window_end ages past a subsequent pass's
 * `from`.
 *
 * `metric_anomalies.window_start`/`detected_at` are naive `timestamp` (no
 * tz) — always written in UTC by the rollup pipeline (see the detectors
 * above). `metric_anomaly_incidents`'s corresponding columns are
 * `timestamptz`. `AT TIME ZONE 'UTC'` converts explicitly rather than
 * relying on an implicit cast, which would reinterpret the naive value using
 * the session's `TimeZone` setting — silently wrong were that setting ever
 * not UTC.
 *
 * See `incidentUpsertAssignments()` above for why `dispatched_at` /
 * `dispatch_attempts` / `agent_run_id` never appear in this statement at
 * all — not in the INSERT column list, not in SELECT, not in the ON
 * CONFLICT SET list. That is the re-publish guard.
 */
async function upsertMetricAnomalyIncidents(options: MetricAnomalyRange): Promise<void> {
  const { from } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();

  await db.execute(sql`
    INSERT INTO metric_anomaly_incidents (
      org_id,
      device_id,
      anomaly_type,
      bucket_seconds,
      window_start,
      first_seen_at,
      last_seen_at,
      peak_score,
      row_count,
      metric_names
    )
    SELECT
      ma.org_id,
      ma.device_id,
      ma.anomaly_type,
      ma.bucket_seconds,
      (ma.window_start AT TIME ZONE 'UTC'),
      (min(ma.detected_at) AT TIME ZONE 'UTC'),
      (max(ma.detected_at) AT TIME ZONE 'UTC'),
      max(ma.score),
      count(*)::integer,
      array_agg(DISTINCT ma.metric_name ORDER BY ma.metric_name)
    FROM metric_anomalies ma
    WHERE ma.org_id = ${options.orgId}
      AND ma.status = 'open'
      AND ma.window_end >= ${fromIso}::timestamp
    GROUP BY ma.org_id, ma.device_id, ma.anomaly_type, ma.bucket_seconds, ma.window_start
    ON CONFLICT (org_id, device_id, anomaly_type, bucket_seconds, window_start)
    DO UPDATE SET ${incidentUpsertAssignments()}
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

/**
 * Why a run that wrote nothing wrote nothing.
 *
 * `timeout` wins over `locked`, deliberately. A lock skip is the DESIGNED
 * outcome — a concurrent run is covering an overlapping window and this one
 * correctly stood down — whereas a timeout means a detector could not finish
 * inside its wait bound, which is the outcome an operator has to act on. A run
 * can end up with both (a stage times out, then a backfill takes the org lock
 * before the next stage starts), and reporting that as a benign `locked` would
 * hide the very signal the bounds exist to raise.
 */
function deriveSkipReason(stages: MetricAnomalyStageResult[]): MetricAnomalySkipReason {
  return stages.some((stage) => stage.outcome === 'timeout') ? 'timeout' : 'locked';
}

export async function detectMetricAnomaliesRange(options: MetricAnomalyRange): Promise<MetricAnomalyResult> {
  const { from, to } = normalizeRange(options.from, options.to);
  const range: MetricAnomalyRange = { orgId: options.orgId, from, to };
  const base = { orgId: options.orgId, from: from.toISOString(), to: to.toISOString() };

  if (!(await readMlFlag(options.orgId, 'ml.anomalies.enabled'))) {
    return { ...base, statements: 0, skipped: true, skippedReason: 'ml-disabled', stages: [] };
  }

  // Task 2 (#3828): `incidents` collapses the rows the three detectors above it
  // just touched into their canonical incident row. It is listed LAST and runs
  // even when an earlier stage was skipped — it reads `metric_anomalies`, so it
  // still has this tick's committed rows plus anything a previous tick left
  // unmaterialised, and skipping it would strand those anomalies with no
  // incident to dispatch.
  const orderedStages: ReadonlyArray<readonly [MetricAnomalyStage, () => Promise<void>]> = [
    ['baseline', () => detectBaselineDeviations(range)],
    ['growth-trend', () => detectGrowthTrends(range)],
    ['process-runaway', () => detectProcessSampleRunaways(range)],
    ['incidents', () => upsertMetricAnomalyIncidents(range)],
  ];

  const stages: MetricAnomalyStageResult[] = [];
  let lockContended = false;

  for (const [stage, run] of orderedStages) {
    const result = await runDetectionStage(stage, options.orgId, run);
    stages.push(result);
    // Stop on `locked` — every later stage takes the SAME org key, so they
    // would all fail to acquire too and the round trips would be pure waste.
    // A `timeout` is per-statement, so the remaining stages still get a turn.
    if (result.outcome === 'locked') {
      lockContended = true;
      break;
    }
  }

  let v1ShadowStatements = 0;
  let v1ShadowSkipped = true;
  if (!lockContended && (await readMlFlag(options.orgId, 'ml.anomalies.v1_shadow.enabled'))) {
    const shadow = await runDetectionStage('v1-shadow', options.orgId, () =>
      detectSeasonalRobustCandidates(range),
    );
    stages.push(shadow);
    v1ShadowSkipped = shadow.outcome !== 'completed';
    v1ShadowStatements = shadow.outcome === 'completed' ? 1 : 0;
    if (shadow.outcome === 'locked') lockContended = true;
  }

  const statements = stages.filter(
    (stage) => stage.stage !== 'v1-shadow' && stage.outcome === 'completed',
  ).length;
  const skipped = statements === 0 && v1ShadowStatements === 0;

  return {
    ...base,
    statements,
    v1ShadowStatements,
    v1ShadowSkipped,
    skipped,
    ...(skipped ? { skippedReason: deriveSkipReason(stages) } : {}),
    stages,
  };
}
