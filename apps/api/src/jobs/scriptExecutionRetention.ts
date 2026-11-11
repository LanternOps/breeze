/**
 * script_executions + script_execution_batches retention (#4342 W2).
 * REPORT-ONLY until SCRIPT_EXECUTION_RETENTION_ENFORCE=true (see retentionTarget.ts).
 *
 * One daily worker runs three targets, in this order, through
 * `runRetentionTargets` (one metric name each, plan correction 19):
 *
 *  1. OUTPUT SCRUB (`script_execution_output_retention`). A terminal execution
 *     older than SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS (default 90) loses its
 *     stdout/stderr; `output_purged_at` records when, and the UI says the
 *     output was removed rather than showing "no output". The row, its status,
 *     exit code and error message stay. `output_purged_at IS NULL` keeps the
 *     scrub idempotent (updateInCtidBatches requires it).
 *  2. ROW DELETE (`script_execution_retention`). A terminal execution older
 *     than SCRIPT_EXECUTION_RETENTION_DAYS (default 365) is deleted, except
 *     the row an unwindowed "newest" reader would return:
 *       - the newest terminal probe per (monitor_id, device_id), ordered as
 *         the monitor verdict reads it (`completed_at DESC NULLS LAST`,
 *         services/alertConditions/handlers/scriptMonitor.ts) — plan
 *         correction 1;
 *       - the newest terminal run per (script_id, org_id) by `created_at`:
 *         the Script Library's "last run" column takes max(created_at) per
 *         script within the caller's orgs (services/scriptLastRun.ts), and a
 *         partner-wide or system script is run by many orgs, so the key
 *         includes org_id or one org's run would erase every other org's.
 *     Ties on the order key are all kept (a safe superset).
 *     `fix_memory` and `remediation_suggestions` reference executions
 *     ON DELETE SET NULL; nothing else has an FK to this table.
 *  3. BATCH DELETE (`script_execution_batch_retention`). Batches never reach
 *     a terminal status (the only status write is 'queued'), so they age by
 *     `created_at` on the row window (plan correction 2). No inbound FKs.
 *
 * Terminal = completed / failed / timeout / cancelled. `cancelling` (a cancel
 * still in flight) and every live status are never eligible, whatever their
 * age. The output window is clamped to at most the row window. All age
 * columns are `timestamp without time zone` holding UTC, so cutoffs go
 * through `utcWallTime`.
 *
 * `script_executions_terminal_age_idx` (W2 migration) serves both
 * script_executions age scans; the keep-newest probes use
 * `script_executions_monitor_device_idx` and
 * `script_executions_script_created_at_idx`. Each batch runs in its own
 * system transaction (retentionBatch.ts); do not wrap this job in a DB context.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import {
  parsePositiveIntEnv,
  resolveRetentionDays,
  retentionEnforceFromEnv,
  utcWallTime,
} from './retentionBatch';
import {
  runRetentionTargets,
  type RetentionKnobs,
  type RetentionTarget,
  type RetentionTargetResult,
} from './retentionTarget';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[ScriptExecutionRetention]';
const QUEUE_NAME = 'script-execution-retention';
const ENFORCE_VAR = 'SCRIPT_EXECUTION_RETENTION_ENFORCE';

const MAX_RETENTION_DAYS = 1095;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.SCRIPT_EXECUTION_RETENTION_DAYS, 365, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const DEFAULT_OUTPUT_RETENTION_DAYS = clampOutputWindow(
  resolveRetentionDays(process.env.SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX),
  DEFAULT_RETENTION_DAYS,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'SCRIPT_EXECUTION_RETENTION_BATCH_SIZE', 1000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'SCRIPT_EXECUTION_RETENTION_MAX_BATCHES', 100);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'SCRIPT_EXECUTION_RETENTION_ENFORCE', false);

/** Output never outlives its row: an output window above the row window is meaningless. */
function clampOutputWindow(outputDays: number, rowDays: number): number {
  if (outputDays > rowDays) {
    console.warn(
      `${LOG_PREFIX} SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS (${outputDays}) exceeds the row window ` +
      `SCRIPT_EXECUTION_RETENTION_DAYS (${rowDays}); using ${rowDays}.`,
    );
    return rowDays;
  }
  return outputDays;
}

// Literal list, written out (plan: terminal rows only). `cancelling` is NOT terminal.
const TERMINAL_STATUSES = sql.raw(`('completed', 'failed', 'timeout', 'cancelled')`);

// The bare outer name `script_executions` is required: retentionBatch selects
// FROM it unaliased. Inner subqueries alias their own copy (`n`, `s`).
const AGED_TERMINAL = (cutoffIso: string) => sql`script_executions.status IN ${TERMINAL_STATUSES}
    AND COALESCE(script_executions.completed_at, script_executions.created_at) < ${utcWallTime(cutoffIso)}`;

/** True unless this row is the newest terminal probe for its (monitor_id, device_id). */
const NOT_NEWEST_MONITOR_PROBE = sql`(script_executions.monitor_id IS NULL OR EXISTS (
      SELECT 1 FROM script_executions n
      WHERE n.monitor_id = script_executions.monitor_id
        AND n.device_id = script_executions.device_id
        AND n.status IN ${TERMINAL_STATUSES}
        AND (n.completed_at > script_executions.completed_at
          OR (script_executions.completed_at IS NULL AND n.completed_at IS NOT NULL))))`;

/** True unless this row is the newest terminal run of its script within its org. */
const NOT_NEWEST_SCRIPT_RUN = sql`(script_executions.script_id IS NULL OR EXISTS (
      SELECT 1 FROM script_executions s
      WHERE s.script_id = script_executions.script_id
        AND s.org_id = script_executions.org_id
        AND s.status IN ${TERMINAL_STATUSES}
        AND s.created_at > script_executions.created_at))`;

export const SCRIPT_EXECUTION_OUTPUT_TARGET: RetentionTarget = {
  metricName: 'script_execution_output_retention',
  table: 'script_executions',
  action: { kind: 'scrub', set: sql`stdout = NULL, stderr = NULL, output_purged_at = now()` },
  // The newest probe's stdout carries the monitor's verdict marker, so it is
  // kept even when an operator sets a very short output window.
  where: (cutoffIso) => sql`${AGED_TERMINAL(cutoffIso)}
    AND script_executions.output_purged_at IS NULL
    AND (stdout IS NOT NULL OR stderr IS NOT NULL)
    AND ${NOT_NEWEST_MONITOR_PROBE}`,
};

export const SCRIPT_EXECUTION_ROW_TARGET: RetentionTarget = {
  metricName: 'script_execution_retention',
  table: 'script_executions',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`${AGED_TERMINAL(cutoffIso)}
    AND ${NOT_NEWEST_MONITOR_PROBE}
    AND ${NOT_NEWEST_SCRIPT_RUN}`,
};

export const SCRIPT_EXECUTION_BATCH_TARGET: RetentionTarget = {
  metricName: 'script_execution_batch_retention',
  table: 'script_execution_batches',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`created_at < ${utcWallTime(cutoffIso)}`,
};

const TARGETS = [SCRIPT_EXECUTION_OUTPUT_TARGET, SCRIPT_EXECUTION_ROW_TARGET, SCRIPT_EXECUTION_BATCH_TARGET] as const;

export interface ScriptExecutionRetentionJobData {
  outputRetentionDays?: number;
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<ScriptExecutionRetentionJobData> | null = null;

export function getScriptExecutionRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runScriptExecutionRetention(
  job: ScriptExecutionRetentionJobData = {},
): Promise<Array<RetentionTargetResult | { table: string; error: string }>> {
  const rowDays = resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, LOG_PREFIX);
  const outputDays = clampOutputWindow(
    resolveRetentionDays(job.outputRetentionDays, DEFAULT_OUTPUT_RETENTION_DAYS, MAX_RETENTION_DAYS, LOG_PREFIX),
    rowDays,
  );
  const shared = {
    batchSize: Math.max(1, job.batchSize ?? BATCH_SIZE),
    maxBatches: Math.max(1, job.maxBatches ?? MAX_BATCHES),
    enforce: ENFORCE && !job.forceReport,
  };
  const knobs = (retentionDays: number): RetentionKnobs => ({ retentionDays, ...shared });

  let results: Array<RetentionTargetResult | { table: string; error: string }>;
  try {
    results = await runRetentionTargets(
      [
        { target: SCRIPT_EXECUTION_OUTPUT_TARGET, knobs: knobs(outputDays) },
        { target: SCRIPT_EXECUTION_ROW_TARGET, knobs: knobs(rowDays) },
        { target: SCRIPT_EXECUTION_BATCH_TARGET, knobs: knobs(rowDays) },
      ],
      { logPrefix: LOG_PREFIX, label: 'scriptExecutionRetention', enforceVar: ENFORCE_VAR },
    );
  } catch (err) {
    // A run that throws before or around the targets must not leave last
    // night's gauges reading as current evidence.
    for (const t of TARGETS) recordRetentionRun(t.metricName, { incomplete: true });
    throw err;
  }

  // runRetentionTargets already logged, captured and flagged each failed
  // target, and ran the rest. Fail the job too, so BullMQ history shows it.
  const failed = results.filter((r): r is { table: string; error: string } => 'error' in r);
  if (failed.length > 0) {
    throw new Error(
      `${LOG_PREFIX} ${failed.length} of ${results.length} targets failed: `
      + failed.map((f) => `${f.table}: ${f.error}`).join('; '),
    );
  }
  return results;
}

export function createScriptExecutionRetentionWorker(): Worker<ScriptExecutionRetentionJobData> {
  return new Worker<ScriptExecutionRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<ScriptExecutionRetentionJobData>) => runScriptExecutionRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeScriptExecutionRetention(): Promise<void> {
  try {
    retentionWorker = createScriptExecutionRetentionWorker();
    attachWorkerObservability(retentionWorker, 'scriptExecutionRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getScriptExecutionRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('script-execution-retention') },
      {
        name: 'sweep',
        data: {
          outputRetentionDays: DEFAULT_OUTPUT_RETENTION_DAYS,
          retentionDays: DEFAULT_RETENTION_DAYS,
          batchSize: BATCH_SIZE,
          maxBatches: MAX_BATCHES,
        },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized (${ENFORCE ? 'ENFORCING' : 'report-only'})`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownScriptExecutionRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  DEFAULT_OUTPUT_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
  ENFORCE,
};
