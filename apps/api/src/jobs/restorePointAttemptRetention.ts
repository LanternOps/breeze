/**
 * Restore-point attempt retention (#8581, follow-up to #4609 / #4751).
 *
 * `device_restore_point_attempts` gets one row per System Restore checkpoint
 * Breeze asked a Windows device to take, and nothing ever removed one. Two
 * daily sweeps, both bounded, both idempotent, both DELETE-only:
 *
 *   1. ORPHANED `requested` rows. A row stays `requested` until an agent result
 *      terminalises it, and several paths never do: every agent before W07
 *      (#4758) ignores the request block, a lost result, a reaped command, an
 *      unlinked row. Those rows are deleted once they are past the retention
 *      window AND past their command's deadline:
 *        - linked rows: the `device_commands` row is gone, or no longer in a
 *          state that can accept an agent result (`pending` / `sent`), so the
 *          ingest path (services/restorePointIngest.ts, which runs only after
 *          that command's terminal compare-and-set) can no longer reach it;
 *        - every row, linked or not: older than the longest a queued command
 *          can wait and then run (the `standard` delivery TTL plus a day of
 *          execution), so a 1-day retention setting still cannot delete the
 *          row a late result is about to terminalise.
 *      The scan rides `device_restore_point_attempts_pending_idx`
 *      (`(requested_at) WHERE status = 'requested'`): the candidate query
 *      filters on exactly that predicate.
 *
 *   2. TERMINAL rows (every status except `requested`) past the retention
 *      window, by `requested_at`.
 *
 * What this job deliberately does NOT do: change a stale `requested` row's
 * status. How a row nobody will ever answer should READ ("Awaiting the
 * device" forever today) is #8582's decision — a new status or a UI age cue.
 * Until then, a `requested` row is only ever kept or deleted, never relabelled.
 *
 * The terminal sweep has no supporting index (the table's indexes lead on
 * device_id / org_id, or are partial on `requested`), so each batch is a
 * LIMITed sequential scan. The table is small (one row per risky action on a
 * Windows device with System Protection on) and old rows sit early in the
 * heap, so the LIMIT stops the scan quickly; an index would need a migration.
 *
 * Each batch runs in its OWN transaction (see retentionBatch.ts's header).
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { deliveryTtlMs } from '../services/commandOfflinePolicy';
import { ACCEPTED_COMMAND_RESULT_STATUSES } from '../services/commandResultAcceptance';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[RestorePointAttemptRetention]';
const QUEUE_NAME = 'restore-point-attempt-retention';
const TABLE = 'device_restore_point_attempts';
const DAY_MS = 86_400_000;

const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.RESTORE_POINT_ATTEMPT_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'RESTORE_POINT_ATTEMPT_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'RESTORE_POINT_ATTEMPT_RETENTION_MAX_BATCHES', 50);

/**
 * Execution allowance on top of the delivery TTL: the longest server-side
 * command timeout is 24 h (WHOLE_MACHINE_RESTORE_TIMEOUT_MS in
 * services/commandTimeouts.ts); the three restore-point triggers are all far
 * shorter (patch 2 h, software install 55 min, script = its own timeout).
 */
const COMMAND_EXECUTION_ALLOWANCE_MS = DAY_MS;

/**
 * The youngest a `requested` row may be and still be an orphan: a command
 * queued for an offline device may wait the whole `standard` delivery TTL
 * (DEVICE_COMMAND_QUEUE_TTL_HOURS, default 7 days) and then run. Read per run,
 * not at import, so it follows the same env knob the command path reads.
 */
function commandLifetimeCeilingMs(): number {
  return deliveryTtlMs('standard') + COMMAND_EXECUTION_ALLOWANCE_MS;
}

export interface RetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface RestorePointAttemptRetentionResult {
  orphansDeleted: number;
  terminalDeleted: number;
  batches: number;
  hasMore: boolean;
  retentionDays: number;
  durationMs: number;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getRestorePointAttemptRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

/** One statement, one transaction, one released connection. */
function inFreshSystemContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * One bounded batch of the orphan sweep.
 *
 * The candidate subquery filters on `status = 'requested'` and a
 * `requested_at` upper bound: the exact shape of
 * `device_restore_point_attempts_pending_idx`, so it is an index range scan in
 * `requested_at` order (proved by EXPLAIN in
 * restorePointAttemptRetention.integration.test.ts).
 *
 * The outer `status = 'requested'` is re-evaluated against the locked row
 * version, so a row an agent result terminalised between the subquery and the
 * delete is left for the terminal sweep rather than deleted as an orphan.
 * SKIP LOCKED steps over a row the ingest path holds right now.
 */
function orphanDeleteStatement(orphanCutoff: string, batchSize: number): SQL {
  // The statuses in which a command can still accept an agent result -- the
  // same set the ingest lookup uses (services/commandResultAcceptance.ts).
  const liveCommandStatuses = sql.join(ACCEPTED_COMMAND_RESULT_STATUSES.map((s) => sql`${s}`), sql`, `);
  return sql`
    DELETE FROM device_restore_point_attempts
    WHERE status = 'requested' AND id IN (
      SELECT a.id
      FROM device_restore_point_attempts a
      WHERE a.status = 'requested' AND a.requested_at < ${orphanCutoff}::timestamptz
        AND (
          a.device_command_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM device_commands c
            WHERE c.id = a.device_command_id AND c.status IN (${liveCommandStatuses})
          )
        )
      ORDER BY a.requested_at
      LIMIT ${batchSize}
      FOR UPDATE OF a SKIP LOCKED
    )
  `;
}

export async function runRestorePointAttemptRetention(
  job: RetentionJobData = {},
): Promise<RestorePointAttemptRetentionResult> {
  const startedAt = Date.now();
  const retentionDays = resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS);
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);

  const retentionMs = retentionDays * DAY_MS;
  // postgres-js does not coerce a JS Date in a template-literal param.
  const terminalCutoff = new Date(startedAt - retentionMs).toISOString();
  // The OLDER of the two: past the retention window AND past any command's
  // possible deadline.
  const orphanCutoff = new Date(startedAt - Math.max(retentionMs, commandLifetimeCeilingMs())).toISOString();

  // ---- 1. orphaned `requested` rows ------------------------------------
  let orphansDeleted = 0;
  let orphanBatches = 0;
  let lastOrphanBatch = 0;
  while (orphanBatches < maxBatches) {
    const result = await inFreshSystemContext('restorePointAttemptRetention.orphans', () =>
      db.execute(orphanDeleteStatement(orphanCutoff, batchSize)),
    );
    lastOrphanBatch = extractRowCount(result);
    orphansDeleted += lastOrphanBatch;
    orphanBatches += 1;
    if (lastOrphanBatch < batchSize) break;
  }
  const orphansHaveMore = orphanBatches >= maxBatches && lastOrphanBatch >= batchSize;

  // ---- 2. terminal rows past the window ---------------------------------
  const terminal = await pruneInCtidBatches({
    table: TABLE,
    where: sql`status <> 'requested' AND requested_at < ${terminalCutoff}::timestamptz`,
    batchSize,
    maxBatches,
    label: 'restorePointAttemptRetention.terminal',
  });

  const durationMs = Date.now() - startedAt;
  const hasMore = orphansHaveMore || terminal.hasMore;
  const batches = orphanBatches + terminal.batches;
  const deleted = orphansDeleted + terminal.deleted;

  console.log(
    `${LOG_PREFIX} Deleted ${terminal.deleted} terminal attempts older than ${retentionDays} days and ` +
    `${orphansDeleted} orphaned requested attempts (batches=${batches}) in ${durationMs}ms`,
  );
  warnOnRetentionBacklog(LOG_PREFIX, TABLE, { deleted, batches, hasMore });
  recordRetentionRun('restore_point_attempt_retention', { rowsDeleted: deleted, incomplete: hasMore });

  return {
    orphansDeleted,
    terminalDeleted: terminal.deleted,
    batches,
    hasMore,
    retentionDays,
    durationMs,
  };
}

export function createRestorePointAttemptRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper here: each sweep opens one per batch so every batch
    // commits and releases its locks (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => runRestorePointAttemptRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeRestorePointAttemptRetention(): Promise<void> {
  try {
    retentionWorker = createRestorePointAttemptRetentionWorker();
    attachWorkerObservability(retentionWorker, 'restorePointAttemptRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Job Scheduler API: addressed by a caller-chosen id, so re-running the
    // initializer replaces the registration instead of leaking one.
    await getRestorePointAttemptRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
      // `every` to the Unix epoch (see jobs/scheduleRegistry.ts).
      { pattern: jobSchedule('restore-point-attempt-retention') },
      {
        name: 'sweep',
        data: { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownRestorePointAttemptRetention(): Promise<void> {
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
  COMMAND_EXECUTION_ALLOWANCE_MS,
  orphanDeleteStatement,
};
