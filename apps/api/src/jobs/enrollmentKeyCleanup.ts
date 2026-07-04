/**
 * Enrollment Key Cleanup Worker
 *
 * Part of the enrollment-key cleanup work (#2196). Task 1 added an on-demand
 * `POST /enrollment-keys/purge-expired` route that purges immediately-expired
 * keys within the caller's tenant scope (see `routes/enrollmentKeys.ts`).
 * This worker complements that route with a system-wide scheduled sweep: it
 * hard-deletes `enrollment_keys` rows that expired more than
 * `ENROLLMENT_KEY_PURGE_AFTER_DAYS` days ago (default 7), across all
 * partners/orgs, so the table doesn't grow unbounded from routine installer
 * churn even when nobody calls the manual purge route.
 *
 * Hard delete is safe: `installer_bootstrap_tokens` and `deployment_invites`
 * both carry `ON DELETE CASCADE` against `enrollment_keys`. Keys with
 * `expires_at IS NULL` never satisfy the `lt` condition below and are
 * therefore never deleted (explicit `isNotNull` guard makes that intent
 * unambiguous rather than relying only on SQL NULL comparison semantics).
 *
 * Scheduling:
 *   - Repeat cron: 04:00 UTC daily (pattern "0 4 * * *")
 *   - `jobId: 'enrollment-key-cleanup'` dedupes the repeatable job across
 *     multiple API replicas — BullMQ will only let one replica claim the
 *     scheduled job at each fire time.
 *
 * Env flags:
 *   - `ENROLLMENT_KEY_CLEANUP_ENABLED` defaults to ON. Operators can set it
 *     to `false` / `0` to disable scheduling in an emergency without a code
 *     deploy. The worker is still initialized (so the queue is reachable for
 *     manual `add()` calls), but no repeatable job is registered.
 *   - `ENROLLMENT_KEY_PURGE_AFTER_DAYS` — integer grace period (days) past
 *     expiry before a key is purged. Default 7.
 *
 * Idempotency:
 *   - A single `DELETE ... WHERE`; running twice in one window simply finds
 *     zero matching rows the second time. Safe to retry on failure.
 *
 * RLS:
 *   - Background jobs have no request-scoped AsyncLocalStorage context, so
 *     the delete is wrapped in `withSystemDbAccessContext` here — the sweep
 *     operates at system scope (no tenant filter), matching the intent of
 *     purging expired keys across all partners.
 */

import { Queue, Worker, Job } from 'bullmq';
import { and, isNotNull, lt } from 'drizzle-orm';
import * as dbModule from '../db';
import { enrollmentKeys } from '../db/schema';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';

const QUEUE_NAME = 'enrollment-key-cleanup';
const JOB_NAME = 'enrollment-key-cleanup';
const REPEAT_JOB_ID = 'enrollment-key-cleanup';
// Daily at 04:00 UTC — off-peak, and staggered from the other 03:00/02:00
// cron jobs (oauthCleanup, reliabilityWorker) to avoid contention.
const DAILY_CRON = '0 4 * * *';
const DEFAULT_PURGE_AFTER_DAYS = 7;

function isCleanupEnabled(): boolean {
  const raw = process.env.ENROLLMENT_KEY_CLEANUP_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function getPurgeAfterDays(): number {
  const raw = process.env.ENROLLMENT_KEY_PURGE_AFTER_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_PURGE_AFTER_DAYS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PURGE_AFTER_DAYS;
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[EnrollmentKeyCleanup] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

export function getEnrollmentKeyCleanupQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return cleanupQueue;
}

export function createEnrollmentKeyCleanupWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        // Unknown job — treat as a no-op so we don't crash the worker.
        console.warn(`[EnrollmentKeyCleanup] Ignoring unknown job name: ${job.name}`);
        return { deletedCount: 0, skipped: true };
      }
      return runWithSystemDbAccess(async () => {
        const startedAt = Date.now();
        const purgeAfterDays = getPurgeAfterDays();
        const cutoff = new Date(Date.now() - purgeAfterDays * 86_400_000);

        const deletedRows = await dbModule.db
          .delete(enrollmentKeys)
          .where(and(isNotNull(enrollmentKeys.expiresAt), lt(enrollmentKeys.expiresAt, cutoff)))
          .returning({ id: enrollmentKeys.id });
        const deletedCount = deletedRows.length;

        const durationMs = Date.now() - startedAt;
        console.log(
          `[EnrollmentKeyCleanup] Deleted ${deletedCount} expired enrollment key(s) (purge-after=${purgeAfterDays}d) in ${durationMs}ms`,
        );
        return { deletedCount, durationMs };
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function scheduleEnrollmentKeyCleanup(
  queue: Queue = getEnrollmentKeyCleanupQueue(),
): Promise<void> {
  // Always clear any previously-registered repeatable so a changed cron
  // pattern takes effect on redeploy (BullMQ keys repeatables by the full
  // option set; stale keys would otherwise accumulate).
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isCleanupEnabled()) {
    console.log(
      '[EnrollmentKeyCleanup] ENROLLMENT_KEY_CLEANUP_ENABLED=false — skipping schedule registration',
    );
    return;
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      // `jobId` guarantees multi-replica dedup: whichever API replica wins
      // the race to create the scheduled job owns it, and BullMQ will
      // refuse duplicate inserts with the same id. Workers on every
      // replica still share processing — only the scheduling is singleton.
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[EnrollmentKeyCleanup] Scheduled daily cleanup (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializeEnrollmentKeyCleanupWorker(): Promise<void> {
  try {
    cleanupWorker = createEnrollmentKeyCleanupWorker();

    cleanupWorker.on('error', (error) => {
      console.error('[EnrollmentKeyCleanup] Worker error:', error);
      captureException(error);
    });

    cleanupWorker.on('failed', (job, error) => {
      console.error(`[EnrollmentKeyCleanup] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleEnrollmentKeyCleanup();
    console.log('[EnrollmentKeyCleanup] Worker initialized');
  } catch (error) {
    console.error('[EnrollmentKeyCleanup] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownEnrollmentKeyCleanupWorker(): Promise<void> {
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }
  if (cleanupQueue) {
    await cleanupQueue.close();
    cleanupQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  DEFAULT_PURGE_AFTER_DAYS,
  isCleanupEnabled,
  getPurgeAfterDays,
};
