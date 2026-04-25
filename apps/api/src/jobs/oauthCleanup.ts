/**
 * OAuth Stale Client Cleanup Worker
 *
 * Follow-up to the OAuth security hardening series. The
 * `cleanupStaleOauthClients` helper (see `oauth/provider.ts`) deletes
 * DCR-registered `oauth_clients` rows that are:
 *   - older than 7 days (DCR_STALE_CLIENT_TTL_MS),
 *   - never used (`last_used_at IS NULL`),
 *   - not partner-bound (`partner_id IS NULL`).
 *
 * Without scheduling, the table grows unbounded when
 * `OAUTH_DCR_ENABLED=true` + `initialAccessToken: false` because anyone
 * can POST /oauth/reg. This worker runs the helper once per day.
 *
 * Scheduling:
 *   - Repeat cron: 03:00 UTC daily (pattern "0 3 * * *")
 *   - `jobId: 'oauth-stale-clients-cleanup'` dedupes the repeatable job
 *     across multiple API replicas — BullMQ will only let one replica
 *     claim the scheduled job at each fire time.
 *
 * Env flag:
 *   - `OAUTH_CLEANUP_ENABLED` defaults to ON. Operators can set it to
 *     `false` / `0` to disable scheduling in an emergency without a
 *     code deploy. The worker is still initialized (so the queue is
 *     reachable for manual `add()` calls), but no repeatable job is
 *     registered.
 *
 * Idempotency:
 *   - `cleanupStaleOauthClients` is a single `DELETE ... WHERE`; running
 *     twice in one window simply finds zero matching rows the second
 *     time. Safe to retry on failure.
 *
 * RLS:
 *   - The helper uses the `db` proxy, which requires an active
 *     AsyncLocalStorage context. Background jobs have none, so we wrap
 *     the call in `withSystemDbAccessContext` here — the GC operates
 *     at the system scope (no tenant filter) which matches the intent
 *     of deleting orphan DCR rows across all partners.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { cleanupStaleOauthClients } from '../oauth/provider';

const QUEUE_NAME = 'oauth-stale-clients-cleanup';
const JOB_NAME = 'oauth-stale-clients-cleanup';
const REPEAT_JOB_ID = 'oauth-stale-clients-cleanup';
// Daily at 03:00 UTC — off-peak for both US and EU traffic patterns, and
// low contention with the other 02:00 cron jobs (reliabilityWorker).
const DAILY_CRON = '0 3 * * *';

function isCleanupEnabled(): boolean {
  const raw = process.env.OAUTH_CLEANUP_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[OauthCleanup] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

export function getOauthCleanupQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return cleanupQueue;
}

export function createOauthCleanupWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        // Unknown job — treat as a no-op so we don't crash the worker.
        console.warn(`[OauthCleanup] Ignoring unknown job name: ${job.name}`);
        return { deletedCount: 0, skipped: true };
      }
      return runWithSystemDbAccess(async () => {
        const startedAt = Date.now();
        const deletedCount = await cleanupStaleOauthClients();
        const durationMs = Date.now() - startedAt;
        console.log(
          `[OauthCleanup] Deleted ${deletedCount} stale DCR oauth_clients row(s) in ${durationMs}ms`,
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

export async function scheduleOauthCleanup(queue: Queue = getOauthCleanupQueue()): Promise<void> {
  // Always clear any previously-registered repeatable so a changed cron
  // pattern takes effect on redeploy (BullMQ keys repeatables by the
  // full option set; stale keys would otherwise accumulate).
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isCleanupEnabled()) {
    console.log('[OauthCleanup] OAUTH_CLEANUP_ENABLED=false — skipping schedule registration');
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
  console.log(`[OauthCleanup] Scheduled daily cleanup (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`);
}

export async function initializeOauthCleanupWorker(): Promise<void> {
  try {
    cleanupWorker = createOauthCleanupWorker();

    cleanupWorker.on('error', (error) => {
      console.error('[OauthCleanup] Worker error:', error);
      captureException(error);
    });

    cleanupWorker.on('failed', (job, error) => {
      console.error(`[OauthCleanup] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleOauthCleanup();
    console.log('[OauthCleanup] Worker initialized');
  } catch (error) {
    console.error('[OauthCleanup] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownOauthCleanupWorker(): Promise<void> {
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
  isCleanupEnabled,
};
