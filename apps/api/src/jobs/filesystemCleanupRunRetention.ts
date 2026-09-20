/**
 * Disk-cleanup run retention (Disk Cleanup v2, spec §5.2; defect 10).
 *
 * `device_filesystem_cleanup_runs` grew without bound: every Cleanup Preview
 * click writes a row carrying up to 1000 candidate objects in `plan`, and
 * nothing ever removed one. Three sweeps, all bounded and all idempotent:
 *
 *   1. DELETE `previewed` runs older than 7 days. An abandoned preview has no
 *      value after the snapshot it pinned has been superseded, and it is the
 *      single biggest row shape in the table.
 *   2. TRIM `plan.preview.candidates` out of `executed`/`failed` runs older
 *      than 90 days. The run's summary, its status, its byte count and its
 *      `executedActions` stay — what goes is the list of paths that WOULD have
 *      been deleted, which nobody reads a quarter later.
 *   3. FAIL `kind='files'` runs stuck in `running` for more than 24 h. Execute
 *      claims its row before dispatching (routes/devices/filesystem.ts), so an
 *      API process that dies mid-dispatch leaves a row no code path will ever
 *      finalise. Scoped to file runs on purpose: a W04 system run legitimately
 *      stays `running` for up to its two-hour timeout and owns its own
 *      terminal transition.
 *
 * Each batch runs in its OWN transaction (see retentionBatch.ts's header): a
 * loop wrapped in one outer `withSystemDbAccessContext` would hold every lock
 * until the last batch committed, which is worse than the unbounded statement
 * batching was supposed to replace.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[FilesystemCleanupRunRetention]';
const QUEUE_NAME = 'filesystem-cleanup-run-retention';
const TABLE = 'device_filesystem_cleanup_runs';

const MAX_PREVIEW_RETENTION_DAYS = 90;
const MAX_PLAN_RETENTION_DAYS = 365;

const PREVIEW_RETENTION_DAYS = resolveRetentionDays(
  process.env.FILESYSTEM_CLEANUP_PREVIEW_RETENTION_DAYS, 7, MAX_PREVIEW_RETENTION_DAYS, LOG_PREFIX,
);
const PLAN_RETENTION_DAYS = resolveRetentionDays(
  process.env.FILESYSTEM_CLEANUP_PLAN_RETENTION_DAYS, 90, MAX_PLAN_RETENTION_DAYS, LOG_PREFIX,
);
/** How long a claimed-but-unfinalised file run may sit in `running`. */
const STUCK_RUN_HOURS = 24;
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'FILESYSTEM_CLEANUP_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'FILESYSTEM_CLEANUP_RETENTION_MAX_BATCHES', 50);

export interface RetentionJobData {
  previewRetentionDays?: number;
  planRetentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getFilesystemCleanupRunRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

/** One statement, one transaction, one released connection. */
function inFreshSystemContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export async function runFilesystemCleanupRunRetention(
  job: RetentionJobData = {},
): Promise<{
  previewsDeleted: number;
  plansTrimmed: number;
  stuckRunsFailed: number;
  batches: number;
  hasMore: boolean;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const previewDays = resolveRetentionDays(job.previewRetentionDays, PREVIEW_RETENTION_DAYS, MAX_PREVIEW_RETENTION_DAYS);
  const planDays = resolveRetentionDays(job.planRetentionDays, PLAN_RETENTION_DAYS, MAX_PLAN_RETENTION_DAYS);
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);

  // postgres-js does not coerce a JS Date in a template-literal param.
  const previewCutoff = new Date(Date.now() - previewDays * 86_400_000).toISOString();
  const planCutoff = new Date(Date.now() - planDays * 86_400_000).toISOString();
  const stuckCutoff = new Date(Date.now() - STUCK_RUN_HOURS * 3_600_000).toISOString();

  // ---- 1. abandoned previews -------------------------------------------
  const prune = await pruneInCtidBatches({
    table: TABLE,
    where: sql`status = 'previewed' AND requested_at < ${previewCutoff}`,
    batchSize,
    maxBatches,
    label: 'filesystemCleanupRunRetention.prunePreviews',
  });

  // ---- 2. trim the pinned candidate list off finished runs --------------
  let plansTrimmed = 0;
  let trimBatches = 0;
  let lastTrimmed = 0;
  while (trimBatches < maxBatches) {
    const result = await inFreshSystemContext('filesystemCleanupRunRetention.trimPlans', () => db.execute(sql`
      UPDATE device_filesystem_cleanup_runs
      SET plan = jsonb_set(
            plan #- '{preview,candidates}',
            '{preview,candidatesTrimmedAt}',
            to_jsonb(now()),
            true
          ),
          updated_at = now()
      WHERE ctid IN (
        SELECT ctid
        FROM device_filesystem_cleanup_runs
        WHERE status IN ('executed', 'failed')
          AND requested_at < ${planCutoff}
          AND jsonb_typeof(plan #> '{preview,candidates}') = 'array'
        LIMIT ${batchSize}
      )
    `));
    lastTrimmed = extractRowCount(result);
    plansTrimmed += lastTrimmed;
    trimBatches += 1;
    if (lastTrimmed < batchSize) break;
  }

  // ---- 3. stuck claims --------------------------------------------------
  let stuckRunsFailed = 0;
  let stuckBatches = 0;
  let lastFailed = 0;
  while (stuckBatches < maxBatches) {
    const stuckResult = await inFreshSystemContext('filesystemCleanupRunRetention.failStuck', () => db.execute(sql`
      UPDATE device_filesystem_cleanup_runs
      SET status = 'failed', error = 'interrupted', updated_at = now()
      WHERE ctid IN (
        SELECT ctid FROM device_filesystem_cleanup_runs
        WHERE kind = 'files'
          AND status = 'running'
          AND approved_at IS NOT NULL
          AND approved_at < ${stuckCutoff}
        LIMIT ${batchSize}
      )
    `));
    lastFailed = extractRowCount(stuckResult);
    stuckRunsFailed += lastFailed;
    stuckBatches += 1;
    if (lastFailed < batchSize) break;
  }

  const durationMs = Date.now() - startedAt;
  const trimHasMore = trimBatches >= maxBatches && lastTrimmed >= batchSize;
  const hasMore = prune.hasMore || trimHasMore || (stuckBatches >= maxBatches && lastFailed >= batchSize);

  console.log(
    `${LOG_PREFIX} Deleted ${prune.deleted} abandoned previews (>${previewDays}d), ` +
    `trimmed ${plansTrimmed} plans (>${planDays}d), failed ${stuckRunsFailed} stuck file runs in ${durationMs}ms`,
  );
  warnOnRetentionBacklog(LOG_PREFIX, TABLE, {
    deleted: prune.deleted + plansTrimmed,
    batches: prune.batches + trimBatches + stuckBatches,
    hasMore,
  });
  recordRetentionRun('filesystem_cleanup_run_retention', {
    rowsDeleted: prune.deleted,
    incomplete: hasMore,
  });

  return {
    previewsDeleted: prune.deleted,
    plansTrimmed,
    stuckRunsFailed,
    batches: prune.batches + trimBatches + stuckBatches,
    hasMore,
    durationMs,
  };
}

export function createFilesystemCleanupRunRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper here: each sweep opens one per batch so every batch
    // commits and releases its locks (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => runFilesystemCleanupRunRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeFilesystemCleanupRunRetention(): Promise<void> {
  try {
    retentionWorker = createFilesystemCleanupRunRetentionWorker();
    attachWorkerObservability(retentionWorker, 'filesystemCleanupRunRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Job Scheduler API (queue.upsertJobScheduler), not the legacy
    // queue.add(..., { repeat }) + getRepeatableJobs()/removeRepeatableByKey()
    // dance: the scheduler is addressed by a caller-chosen id, so re-running
    // the initializer replaces the registration instead of leaking one.
    await getFilesystemCleanupRunRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
      // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
      // together (see jobs/scheduleRegistry.ts).
      { pattern: jobSchedule('filesystem-cleanup-run-retention') },
      {
        name: 'sweep',
        data: {
          previewRetentionDays: PREVIEW_RETENTION_DAYS,
          planRetentionDays: PLAN_RETENTION_DAYS,
          batchSize: BATCH_SIZE,
          maxBatches: MAX_BATCHES,
        },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownFilesystemCleanupRunRetention(): Promise<void> {
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
  PREVIEW_RETENTION_DAYS,
  PLAN_RETENTION_DAYS,
  STUCK_RUN_HOURS,
  BATCH_SIZE,
  MAX_BATCHES,
};
