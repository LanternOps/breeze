/**
 * Bounded cleanup for durable browser authentication transitions.
 *
 * One stable BullMQ repeatable job runs daily across the API fleet. The
 * service owns transaction and row-lock semantics; this worker only provides
 * scheduling, observability, and lifecycle management.
 */
import { Job, Queue, Worker } from 'bullmq';
import { cleanupAuthBrowserTransitions } from '../services/authBrowserTransition';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const QUEUE_NAME = 'auth-browser-transition-cleanup';
const JOB_NAME = 'auth-browser-transition-cleanup';
const REPEAT_JOB_ID = 'auth-browser-transition-cleanup';
// Staggered from the 04:00 enrollment-key cleanup job.
const DAILY_CRON = '17 4 * * *';
const CLEANUP_BATCH_SIZE = 500;

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

export function getAuthBrowserTransitionCleanupQueue(): Queue {
  cleanupQueue ??= new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return cleanupQueue;
}

export function createAuthBrowserTransitionCleanupWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[AuthBrowserTransitionCleanup] Ignoring unknown job name: ${job.name}`);
        return { retiredPending: 0, deletedRetired: 0, skipped: true };
      }

      const startedAt = Date.now();
      const counts = await cleanupAuthBrowserTransitions({ batchSize: CLEANUP_BATCH_SIZE });
      const durationMs = Date.now() - startedAt;
      console.log(
        `[AuthBrowserTransitionCleanup] retiredPending=${counts.retiredPending} deletedRetired=${counts.deletedRetired} durationMs=${durationMs}`,
      );
      return { ...counts, durationMs };
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleAuthBrowserTransitionCleanup(
  queue: Queue = getAuthBrowserTransitionCleanupQueue(),
): Promise<void> {
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[AuthBrowserTransitionCleanup] Scheduled daily cleanup (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializeAuthBrowserTransitionCleanupWorker(): Promise<void> {
  try {
    cleanupWorker = createAuthBrowserTransitionCleanupWorker();
    cleanupWorker.on('error', (error) => {
      console.error('[AuthBrowserTransitionCleanup] Worker error:', error);
      captureException(error);
    });
    cleanupWorker.on('failed', (job, error) => {
      console.error(`[AuthBrowserTransitionCleanup] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    await scheduleAuthBrowserTransitionCleanup();
    console.log('[AuthBrowserTransitionCleanup] Worker initialized');
  } catch (error) {
    console.error('[AuthBrowserTransitionCleanup] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAuthBrowserTransitionCleanupWorker(): Promise<void> {
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }
  if (cleanupQueue) {
    await cleanupQueue.close();
    cleanupQueue = null;
  }
}

export const __testOnly = Object.freeze({
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  CLEANUP_BATCH_SIZE,
});
