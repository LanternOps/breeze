/**
 * Software Remediation Request Cleanup Worker (issue #3614, follow-up to #3585).
 *
 * #3585 backed manual software remediation with a durable single-use
 * authorization token: one `software_remediation_requests` row per targeted
 * device, consumed atomically by `consumeManualRemediationAuthorization`.
 * Nothing pruned them.
 *
 * A single Remediate click mints up to 500 rows (one per violating device, the
 * route's cap). Every device that never reports back — offline, decommissioned
 * between the click and the dispatch, agent wedged — leaves its row behind
 * until the device, policy, or org is deleted and the FK cascade takes it. On
 * an active fleet that is unbounded growth on a table that only ever needs a
 * short window of history.
 *
 * This sweep deletes rows that are past `expires_at` by a comfortable margin.
 * The margin matters: a row is only useful up to its own expiry, but keeping it
 * a while longer means a support question ("who authorized that uninstall, and
 * when?") is still answerable from the row rather than only from the audit log.
 * CONSUMED rows are deleted on the same schedule — the audit entry written at
 * consume time is the durable record, not this row.
 *
 * The DELETE is batched and re-checks the same cutoff predicate it selected on,
 * so a row cannot be removed by a cutoff it no longer matches.
 *
 * Why its own job rather than an existing sweep: every other retention concern
 * in this directory owns one small worker (`mlOutputRetention`,
 * `enrollmentKeyCleanup`, `softwareUploadSessionCleanup`, ...), and the
 * remediation worker itself is job-driven with no repeatable component to hang
 * this on. Grafting an unrelated table onto another domain's sweep would hide
 * it from anyone reading that file.
 *
 * Scheduling: hourly cron ('35 * * * *'), jobId-deduped across replicas.
 * RLS: runs inside withSystemDbAccessContext (background job, all tenants).
 * Idempotent: re-running finds zero expired rows.
 * Env: SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED (default on),
 *      SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS (default 72).
 */
import { Queue, Worker, Job } from 'bullmq';
import { and, inArray, lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { softwareRemediationRequests } from '../db/schema';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'software-remediation-request-cleanup';
const JOB_NAME = 'software-remediation-request-cleanup';
const REPEAT_JOB_ID = 'software-remediation-request-cleanup';
// Hourly at :35 — staggered from the :15 upload-session sweep and the daily
// 02:00-04:00 retention jobs.
const HOURLY_CRON = '35 * * * *';
// Hours PAST expires_at, not past created_at: the grace is measured from the
// point the row stopped being usable.
const DEFAULT_RETENTION_HOURS = 72;
const BATCH_SIZE = 5_000;
// Hard bound on one sweep. Without it, a table receiving eligible rows as fast
// as they are deleted keeps every batch full and `for(;;)` never exits — the
// hourly schedule means the remainder is picked up 60 minutes later anyway.
const MAX_BATCHES = 50;

function isCleanupEnabled(): boolean {
  const raw = process.env.SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED;
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function getRetentionHours(): number {
  const raw = process.env.SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_HOURS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_HOURS;
}

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

export function getSoftwareRemediationRequestCleanupQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return cleanupQueue;
}

/**
 * Prunes expired authorization rows.
 *
 * Establishes its OWN system context per batch via
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))`, the same pattern
 * `createManualRemediationAuthorizations` uses. Two reasons, both learned the
 * hard way in review:
 *
 * 1. SAFETY. Relying on the caller was not enough, and a plain nested
 *    `withSystemDbAccessContext` would NOT have fixed it: `withDbAccessContext`
 *    short-circuits to `fn()` when a context already exists (db/index.ts), so a
 *    nested call keeps the REQUEST's org scope instead of escalating — it would
 *    look protected while pruning only that org's rows and reporting a
 *    whole-table sweep. `runOutsideDbContext` exits both stores, so the nested
 *    call opens a genuinely fresh system context. Marking the function
 *    `__testOnly` was NOT a guard either: that object is an ordinary runtime
 *    export any module can import.
 *
 * 2. LOCK DURATION. `withSystemDbAccessContext` opens ONE transaction that does
 *    not commit until its callback returns. Wrapping the whole sweep therefore
 *    kept every batch's row locks and dead tuples in a single transaction — up
 *    to MAX_BATCHES * BATCH_SIZE rows — which defeated the point of batching.
 *    Per-batch contexts mean each batch commits on its own. The sweep is not
 *    atomic, which is correct for an idempotent retention job: a partial run
 *    simply prunes fewer rows and the next hourly run finishes.
 */
export async function pruneExpiredRemediationRequests(): Promise<{
  deletedCount: number;
  batches: number;
  retentionHours: number;
  /**
   * The batch cap stopped the sweep AND a probe still saw an eligible row.
   * A point-in-time observation, not a guarantee: a concurrent FK cascade can
   * remove that row immediately after, and a fresh expiry can appear right
   * after a negative probe.
   */
  hasMore: boolean;
}> {
  const retentionHours = getRetentionHours();
  const cutoff = new Date(Date.now() - retentionHours * 3_600_000);
  let deletedCount = 0;
  let batches = 0;
  let hasMore = false;

  const inSystemContext = <T>(fn: () => Promise<T>): Promise<T> =>
    runOutsideDbContext(() => withSystemDbAccessContext(fn));

  while (batches < MAX_BATCHES) {
    // One transaction per batch — see the LOCK DURATION note above.
    const deletedInBatch = await inSystemContext(async () => {
      const expired = await db
        .select({ id: softwareRemediationRequests.id })
        .from(softwareRemediationRequests)
        .where(lt(softwareRemediationRequests.expiresAt, cutoff))
        .limit(BATCH_SIZE);

      if (expired.length === 0) return null;

      const deleted = await db
        .delete(softwareRemediationRequests)
        .where(and(
          inArray(softwareRemediationRequests.id, expired.map((r) => r.id)),
          lt(softwareRemediationRequests.expiresAt, cutoff),
        ))
        .returning({ id: softwareRemediationRequests.id });

      return { deleted: deleted.length, selected: expired.length };
    });

    if (deletedInBatch === null) break;

    deletedCount += deletedInBatch.deleted;
    batches += 1;

    // A short batch means nothing eligible was left AT SELECT TIME. Rows
    // inserted concurrently are deliberately left for the next hourly run
    // rather than chasing a moving target inside one sweep.
    if (deletedInBatch.selected < BATCH_SIZE) break;

    if (batches >= MAX_BATCHES) {
      // Cap reached on a FULL batch. Probe before claiming a backlog, so a
      // sweep that happened to drain the table on its last batch does not send
      // someone chasing nothing. LIMIT 1 bounds the rows returned, not the work:
      // the only expires_at index is partial on `consumed_at IS NULL` and this
      // predicate spans consumed rows too, so an exact drain can cost a scan.
      // Acceptable at most once per capped run.
      const leftover = await inSystemContext(async () => {
        const [row] = await db
          .select({ id: softwareRemediationRequests.id })
          .from(softwareRemediationRequests)
          .where(lt(softwareRemediationRequests.expiresAt, cutoff))
          .limit(1);
        return row;
      });
      hasMore = Boolean(leftover);
    }
  }

  return { deletedCount, batches, retentionHours, hasMore };
}

export function createSoftwareRemediationRequestCleanupWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[SoftwareRemediationRequestCleanup] Ignoring unknown job name: ${job.name}`);
        return { deletedCount: 0, skipped: true };
      }
      {
        // No context wrapper here: the prune establishes its own per batch.
        const startedAt = Date.now();
        const result = await pruneExpiredRemediationRequests();
        const durationMs = Date.now() - startedAt;
        if (result.hasMore) {
          console.warn(
            `[SoftwareRemediationRequestCleanup] Hit the ${MAX_BATCHES}-batch cap with rows still eligible; ` +
            'the remainder is left for the next hourly run.',
          );
        }
        if (result.deletedCount > 0) {
          console.log(
            `[SoftwareRemediationRequestCleanup] Deleted ${result.deletedCount} expired authorization row(s) ` +
            `(expired >${result.retentionHours}h ago, ${result.batches} batch(es)) in ${durationMs}ms`,
          );
        }
        return { ...result, durationMs };
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleSoftwareRemediationRequestCleanup(
  queue: Queue = getSoftwareRemediationRequestCleanupQueue(),
): Promise<void> {
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  if (!isCleanupEnabled()) {
    console.log(
      '[SoftwareRemediationRequestCleanup] SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED=false — skipping schedule registration',
    );
    return;
  }
  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: HOURLY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[SoftwareRemediationRequestCleanup] Scheduled hourly cleanup (cron "${HOURLY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializeSoftwareRemediationRequestCleanupWorker(): Promise<void> {
  try {
    cleanupWorker = createSoftwareRemediationRequestCleanupWorker();
  attachWorkerObservability(cleanupWorker, 'softwareRemediationRequestCleanup');
    cleanupWorker.on('error', (error) => {
      console.error('[SoftwareRemediationRequestCleanup] Worker error:', error);
      captureException(error);
    });
    cleanupWorker.on('failed', (job, error) => {
      console.error(`[SoftwareRemediationRequestCleanup] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    await scheduleSoftwareRemediationRequestCleanup();
    console.log('[SoftwareRemediationRequestCleanup] Worker initialized');
  } catch (error) {
    console.error('[SoftwareRemediationRequestCleanup] Failed to initialize:', error);
    // The worker is created BEFORE the schedule call, so a Redis failure while
    // scheduling would otherwise leave a live worker and queue behind for the
    // rest of the process: initializeWorkers() logs and keeps running.
    await shutdownSoftwareRemediationRequestCleanupWorker().catch(() => {});
    throw error;
  }
}

export async function shutdownSoftwareRemediationRequestCleanupWorker(): Promise<void> {
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }
  if (cleanupQueue) {
    await cleanupQueue.close();
    cleanupQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  HOURLY_CRON,
  DEFAULT_RETENTION_HOURS,
  BATCH_SIZE,
  MAX_BATCHES,
  isCleanupEnabled,
  getRetentionHours,
};
