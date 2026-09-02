import { Job, Queue, Worker } from 'bullmq';
import { cleanupAuthBrowserTransitions } from '../services/authBrowserTransition';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';

const QUEUE_NAME = 'auth-browser-transition-cleanup';
const JOB_NAME = 'auth-browser-transition-cleanup';
const DAILY_CRON = jobSchedule('auth-browser-transition-cleanup');
const BATCH_SIZE = 500;

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

function getQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return cleanupQueue;
}

export function createAuthBrowserTransitionCleanupWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        throw new Error(`Unknown auth browser transition cleanup job: ${job.name}`);
      }
      const stats = await cleanupAuthBrowserTransitions({ batchSize: BATCH_SIZE });
      console.log(
        `[AuthBrowserTransitionCleanup] retiredPending=${stats.retiredPending} deletedRetired=${stats.deletedRetired}`,
      );
      return stats;
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleAuthBrowserTransitionCleanup(
  queue: Queue = getQueue(),
): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(JOB_NAME, {}, {
    jobId: JOB_NAME,
    repeat: { pattern: DAILY_CRON },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}

export async function initializeAuthBrowserTransitionCleanupWorker(): Promise<void> {
  if (cleanupWorker) return;
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
  DAILY_CRON,
  BATCH_SIZE,
});
