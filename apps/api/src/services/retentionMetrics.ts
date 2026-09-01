import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

/**
 * Prometheus observability for the retention job family and the metric-rollup
 * pipeline (#4345). Before this, `/metrics` said nothing about the ~15 retention
 * workers or the rollup runner: a job that silently stopped deleting, or one
 * permanently pinned at its MAX_BATCHES cap while its table grew, was invisible
 * until someone noticed the disk.
 *
 * Same shape as `services/actionIntents/metrics.ts` and
 * `services/anomalyMetrics.ts`: a settable recorder so `jobs/*` can emit without
 * importing `routes/metrics` (which pulls the whole metrics + backup graph and
 * would close an import cycle), plus a `register*` function that `routes/metrics`
 * calls once at startup to bind the real Prometheus instruments. Until that call
 * every `record*` here is a no-op.
 */

/**
 * Closed set of instrumented jobs — the `job_name` label's only possible values,
 * so the series stays bounded. Sorted; keep it that way (asserted in the test).
 * Add a name here when you instrument a new retention worker.
 *
 * `jobs/backupRetention.ts` is deliberately absent: it is a library of two
 * separately-invoked sweeps (row-level snapshot cleanup and object-storage GC)
 * with two independent totals, driven from `jobs/backupWorker.ts`, and backup
 * already has its own dedicated instrument set in `services/backupMetrics.ts`.
 */
export const RETENTION_JOB_NAMES = [
  'agent_log_retention',
  'ai_unattended_exposure_retention',
  'audit_retention',
  'change_log_retention',
  'device_metrics_retention',
  'event_log_retention',
  'ip_history_retention',
  'metric_rollup_maintenance',
  'ml_output_retention',
  'playbook_retention',
  'process_sample_retention',
  'reliability_retention',
  'service_process_check_retention',
  'snmp_retention',
  'user_risk_retention',
] as const;

export type RetentionJobName = (typeof RETENTION_JOB_NAMES)[number];

export type RollupRunStatus = 'success' | 'failure' | 'skipped';

export interface RetentionRunOutcome {
  /**
   * Rows this run deleted. OMIT (don't pass 0) for a job that does not capture a
   * row count — `event_log_retention`, `snmp_retention`, `playbook_retention`
   * discard their DELETE results — so those jobs publish only a last-run stamp.
   * A permanent 0 on the counter would read as "deleted nothing", which is a
   * different claim from "not measured".
   */
  rowsDeleted?: number;
  /**
   * True when the run did NOT clear everything it was supposed to, so rows
   * remain past the cutoff. Two causes, both meaning the same thing to an
   * operator:
   *
   *  - A batch-capped job hit its MAX_BATCHES ceiling with a full final batch
   *    (`ml_output_retention`, `user_risk_retention`, `reliability_retention`,
   *    `metric_rollup_maintenance`).
   *  - A per-item loop swallowed failures and moved on, leaving those items
   *    unpruned (`audit_retention` errors per policy, `event_log_retention`
   *    skips orgs whose retention lookup failed, `playbook_retention` runs two
   *    independently-failing halves).
   *
   * That second group is why this is not named `hasMore`: without it, a run in
   * which EVERY item failed still publishes a fresh last-run stamp and a 0-row
   * counter, and a staleness alert built on those never fires. The underlying
   * errors are captured to Sentry per item, but the metric surface this module
   * exists to provide would otherwise say nothing was wrong.
   *
   * Omit entirely for jobs with no completeness signal at all.
   */
  incomplete?: boolean;
}

interface RetentionMetricsRecorder {
  onRetentionRun: (jobName: RetentionJobName, outcome: RetentionRunOutcome) => void;
  onRollupRun: (status: RollupRunStatus, durationSeconds: number) => void;
}

const noop = () => {};

let recorder: RetentionMetricsRecorder = {
  onRetentionRun: noop,
  onRollupRun: noop,
};

export function setRetentionMetricsRecorder(
  next: Partial<RetentionMetricsRecorder> | null | undefined
): void {
  recorder = {
    onRetentionRun: next?.onRetentionRun ?? noop,
    onRollupRun: next?.onRollupRun ?? noop,
  };
}

/**
 * Every `record*` below is best-effort and swallows its own failure. This is
 * load-bearing, not defensive habit:
 *
 *  - Each of the 15 retention call sites sits immediately AFTER the DELETE has
 *    committed and immediately BEFORE the job's `return`. A throw here would
 *    turn a completed, successful purge into a `failed` BullMQ job with a
 *    metrics-library stack trace as its apparent cause.
 *  - Worse, `rollupDeviceMetricsRange` calls this from inside a `catch` block.
 *    A throw there would REPLACE the in-flight rollup error before the rethrow
 *    ran, discarding the actual failure entirely.
 *
 * prom-client's `labels()` throws on an arg-count mismatch and `inc()` throws on
 * a non-finite value, so the invariant is one careless future label change away
 * from being violated. Enforce it here rather than trusting 16 call sites to.
 */
function safelyRecord(what: string, emit: () => void): void {
  try {
    emit();
  } catch (error) {
    console.error(`[RetentionMetrics] Failed to record ${what}:`, error);
  }
}

/**
 * Record one completed retention run. Always stamps
 * `breeze_retention_last_run_timestamp_seconds{job_name}`; additionally moves
 * the rows-deleted counter and/or the backlog gauge when the caller supplies
 * those signals. Instrumentation only — never throws into a job's success path.
 */
export function recordRetentionRun(
  jobName: RetentionJobName,
  outcome: RetentionRunOutcome = {}
): void {
  safelyRecord(`run for ${jobName}`, () => recorder.onRetentionRun(jobName, outcome));
}

/** Record one metric-rollup run (`services/metricRollups.ts::rollupDeviceMetricsRange`). */
export function recordRollupRun(status: RollupRunStatus, durationSeconds: number): void {
  safelyRecord(`rollup run (${status})`, () => recorder.onRollupRun(status, durationSeconds));
}

const ROWS_DELETED_METRIC = 'breeze_retention_rows_deleted_total';
const LAST_RUN_METRIC = 'breeze_retention_last_run_timestamp_seconds';
const BACKLOG_METRIC = 'breeze_retention_backlog_incomplete';
const ROLLUP_RUNS_METRIC = 'breeze_rollup_runs_total';
const ROLLUP_DURATION_METRIC = 'breeze_rollup_duration_seconds';

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function safeSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Registers (or reuses, if this Registry already carries them) the five series
 * and binds them as the live recorder. Called once from `routes/metrics.ts`.
 *
 * NOTHING is seeded here — deliberately. The retention workers are `global` /
 * `socket-owner` placements in `services/workerRegistry.ts`, so exactly one
 * instance runs each of them. Seeding `last_run_timestamp = 0` at boot (the
 * pattern `fleetGaugeLastRefreshGauge` uses) would publish a permanent
 * "never ran" series on every replica that legitimately never runs the job, and
 * any staleness alert built on it would fire forever. A series appearing only
 * once the job has actually run is the honest signal; alert with `absent()` or
 * `max by (job_name)` across the fleet.
 */
export function registerRetentionPrometheusMetrics(registry: Registry): void {
  const rowsDeletedTotal =
    (registry.getSingleMetric(ROWS_DELETED_METRIC) as Counter<'job_name'> | undefined) ??
    new Counter({
      name: ROWS_DELETED_METRIC,
      help: 'Rows deleted by each retention job since process start',
      labelNames: ['job_name'] as const,
      registers: [registry],
    });

  const lastRunTimestampSeconds =
    (registry.getSingleMetric(LAST_RUN_METRIC) as Gauge<'job_name'> | undefined) ??
    new Gauge({
      name: LAST_RUN_METRIC,
      help: 'Unix timestamp of the last completed run of each retention job',
      labelNames: ['job_name'] as const,
      registers: [registry],
    });

  const backlogIncomplete =
    (registry.getSingleMetric(BACKLOG_METRIC) as Gauge<'job_name'> | undefined) ??
    new Gauge({
      name: BACKLOG_METRIC,
      help: '1 when a retention job left rows behind (hit its MAX_BATCHES ceiling, or skipped items that errored), 0 when it fully cleared the backlog',
      labelNames: ['job_name'] as const,
      registers: [registry],
    });

  const rollupRunsTotal =
    (registry.getSingleMetric(ROLLUP_RUNS_METRIC) as Counter<'status'> | undefined) ??
    new Counter({
      name: ROLLUP_RUNS_METRIC,
      help: 'Metric-rollup runs by outcome',
      labelNames: ['status'] as const,
      registers: [registry],
    });

  // Histogram, matching breeze_s1_sync_duration_seconds — the existing
  // job-duration pattern on this registry — with the same bucket ladder.
  const rollupDurationSeconds =
    (registry.getSingleMetric(ROLLUP_DURATION_METRIC) as Histogram<'status'> | undefined) ??
    new Histogram({
      name: ROLLUP_DURATION_METRIC,
      help: 'Metric-rollup run duration in seconds by outcome',
      labelNames: ['status'] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [registry],
    });

  setRetentionMetricsRecorder({
    onRetentionRun: (jobName, outcome) => {
      lastRunTimestampSeconds.labels(jobName).set(Date.now() / 1000);
      if (outcome.rowsDeleted !== undefined) {
        rowsDeletedTotal.labels(jobName).inc(safeCount(outcome.rowsDeleted));
      }
      if (outcome.incomplete !== undefined) {
        backlogIncomplete.labels(jobName).set(outcome.incomplete ? 1 : 0);
      }
    },
    onRollupRun: (status, durationSeconds) => {
      rollupRunsTotal.labels(status).inc();
      rollupDurationSeconds.labels(status).observe(safeSeconds(durationSeconds));
    },
  });
}
