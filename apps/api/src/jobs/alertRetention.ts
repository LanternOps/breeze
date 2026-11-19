/**
 * Closed-alert retention (#4342 W3) — `alerts`, then orphaned
 * `alert_correlation_groups`. REPORT-ONLY until ALERT_RETENTION_ENFORCE=true.
 *
 * WHAT IS ELIGIBLE
 * ----------------
 * An alert is eligible only when it is CLOSED (`resolved` / `dismissed`) and
 * its close time (`COALESCE(resolved_at, dismissed_at)`, a tz-less UTC column)
 * is past ALERT_RETENTION_DAYS (default 365, max 1095). An open alert
 * (`active` / `acknowledged` / `suppressed`) is never eligible, at any age.
 * Two guards then keep closed rows that something still reads:
 *
 *  1. Newest closed alert per (rule, owner kind, device, subject) — the cursor guard
 *     (#10538). Before re-opening an event-based rule, the alert sweep reads
 *     the frozen evidence cursor from the newest closed alert of that key
 *     (`services/alertLifecycle/cursor.ts` `closedCursorsQuery`), with no age
 *     bound. Deleting it would re-fire the rule on evidence it already
 *     consumed. "Newer" is a strictly greater close time — the reader's own
 *     ordering, which has no tiebreak — so rows tied on the newest time are
 *     all kept (a safe superset). `device_id` is nullable (non-device owners),
 *     so the key compares it with IS NOT DISTINCT FROM: a plain `=` would make
 *     every NULL-keyed row "the newest" and keep them all forever (plan
 *     correction 5). The key also includes `owner_kind`, because the reader
 *     reads device-owned rows only and a topology-site alert carries its
 *     origin `device_id` as provenance: without it, a newer topology alert
 *     would shield nothing the reader uses and expose the device cursor row.
 *     An alert with no rule has no cursor and no such guard.
 *     Served by `alerts_rule_device_subject_closed_idx`.
 *
 *  2. Ticket-linked alerts (OD 7, plan correction 4). An alert referenced by
 *     `ticket_alert_links`, `psa_ticket_mappings` or `alert_external_refs`
 *     (partner-principal ticket refs) is kept: all three CASCADE on alert
 *     delete, so deleting the alert would silently unlink the ticket.
 *
 * A deleted alert takes its `alert_notifications`, `alert_correlations`,
 * `alert_correlation_members` and `ai_alert_verdicts` with it (CASCADE). Every
 * other reference is a nullable back-pointer that is cleared (SET NULL):
 * `remediation_suggestions`, `metric_anomalies`, `metric_anomaly_episodes`,
 * `ai_agent_runs`, `ai_agent_fix_watches`, `fix_outcomes`,
 * `alert_correlation_groups.root_alert_id`, and — since migration
 * 2027-01-23-102000 — `log_correlations` and `network_change_events`, which
 * were NO ACTION and would have aborted the delete.
 *
 * A closed alert with neither close stamp (legacy or hand-edited rows) is never
 * eligible — `NULL < cutoff` is not true — and never shields an older one. It
 * fails safe: kept, not counted.
 *
 * A correlation group is eligible once nothing points into it: no root alert,
 * no member, and `last_seen_at` past the same window. It runs second, so a
 * group whose root and members were removed above goes in the same run.
 * Consequence for the report: in report mode no alert is removed first, so
 * `alert_correlation_group_retention`'s eligible count is a LOWER BOUND on
 * what the first enforcing run deletes (it also takes the groups emptied by
 * that run's alert deletes). The `alert_retention` count has no such gap.
 *
 * REPORT FIRST
 * ------------
 * Both targets go through `runRetentionTargets` (`retentionTarget.ts`): with
 * the flag unset they only count, log `REPORT-ONLY` and set
 * `breeze_retention_rows_eligible{job_name}`. A job payload cannot turn
 * deletion on; its only switch is `forceReport`.
 *
 * Retention keys on status and age, not on tenant, so this is one global
 * sweep, not a per-org fan-out. Never wrap it in a DB context: each batch
 * opens its own system transaction (`retentionBatch.ts`).
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { getBullMQConnection } from '../services/redis';
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

const LOG_PREFIX = '[AlertRetention]';
const QUEUE_NAME = 'alert-retention';
const ENFORCE_VAR = 'ALERT_RETENTION_ENFORCE';

const MAX_RETENTION_DAYS = 1095;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.ALERT_RETENTION_DAYS, 365, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'ALERT_RETENTION_BATCH_SIZE', 1000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'ALERT_RETENTION_MAX_BATCHES', 100);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'ALERT_RETENTION_ENFORCE', false);

const CLOSED = sql`('resolved', 'dismissed')`;

/** Closed alerts past the window, minus the cursor row per key and ticket-linked alerts. */
export const ALERT_RETENTION_TARGET: RetentionTarget = {
  metricName: 'alert_retention',
  table: 'alerts',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`alerts.status IN ${CLOSED}
    AND COALESCE(alerts.resolved_at, alerts.dismissed_at) < ${utcWallTime(cutoffIso)}
    AND (alerts.rule_id IS NULL OR EXISTS (
      SELECT 1 FROM alerts n
      WHERE n.rule_id = alerts.rule_id
        AND n.owner_kind = alerts.owner_kind
        AND n.device_id IS NOT DISTINCT FROM alerts.device_id
        AND COALESCE(n.subject_key, '') = COALESCE(alerts.subject_key, '')
        AND n.status IN ${CLOSED}
        AND COALESCE(n.resolved_at, n.dismissed_at) > COALESCE(alerts.resolved_at, alerts.dismissed_at)
    ))
    AND NOT EXISTS (SELECT 1 FROM ticket_alert_links l WHERE l.alert_id = alerts.id)
    AND NOT EXISTS (SELECT 1 FROM psa_ticket_mappings p WHERE p.alert_id = alerts.id)
    AND NOT EXISTS (SELECT 1 FROM alert_external_refs r WHERE r.alert_id = alerts.id)`,
};

/** Correlation groups nothing points into any more, idle past the window. */
export const ALERT_CORRELATION_GROUP_TARGET: RetentionTarget = {
  metricName: 'alert_correlation_group_retention',
  table: 'alert_correlation_groups',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`alert_correlation_groups.root_alert_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM alert_correlation_members m WHERE m.group_id = alert_correlation_groups.id)
    AND alert_correlation_groups.last_seen_at < ${utcWallTime(cutoffIso)}`,
};

export interface AlertRetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  /** Count only, even when ALERT_RETENTION_ENFORCE=true. There is no payload switch that enables deletion. */
  forceReport?: boolean;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<AlertRetentionJobData> | null = null;

export function getAlertRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

/**
 * Runs both targets in order. Every target runs even if an earlier one throws
 * (`runRetentionTargets` logs and captures it); the job then fails, so a
 * partial run is never recorded as a clean one.
 */
export async function runAlertRetention(job: AlertRetentionJobData = {}): Promise<RetentionTargetResult[]> {
  const knobs: RetentionKnobs = {
    retentionDays: resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS),
    batchSize: Math.max(1, Math.trunc(job.batchSize ?? BATCH_SIZE) || 1),
    maxBatches: Math.max(1, Math.trunc(job.maxBatches ?? MAX_BATCHES) || 1),
    enforce: ENFORCE && !job.forceReport,
  };

  const results = await runRetentionTargets(
    [
      { target: ALERT_RETENTION_TARGET, knobs },
      { target: ALERT_CORRELATION_GROUP_TARGET, knobs },
    ],
    { logPrefix: LOG_PREFIX, label: 'alertRetention', enforceVar: ENFORCE_VAR },
  );

  const failed = results.filter((r): r is { table: string; error: string } => 'error' in r);
  if (failed.length > 0) {
    throw new Error(`${LOG_PREFIX} ${failed.map((f) => `${f.table}: ${f.error}`).join('; ')}`);
  }
  return results as RetentionTargetResult[];
}

export function createAlertRetentionWorker(): Worker<AlertRetentionJobData> {
  return new Worker<AlertRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<AlertRetentionJobData>) => runAlertRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAlertRetention(): Promise<void> {
  try {
    retentionWorker = createAlertRetentionWorker();
    attachWorkerObservability(retentionWorker, 'alertRetention');

    retentionWorker.on('failed', (job, error) => {
      // No captureException here: runRetentionTargets captured each failed
      // target with its table tag, and attachWorkerObservability captures the
      // job failure itself.
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getAlertRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('alert-retention') },
      {
        name: 'sweep',
        data: { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized (${ENFORCE ? 'ENFORCING' : 'report-only'})`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownAlertRetention(): Promise<void> {
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
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
  ENFORCE,
};
