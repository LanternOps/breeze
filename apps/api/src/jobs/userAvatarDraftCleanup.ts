import { Job, Queue, Worker } from 'bullmq';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { cleanupExpiredAvatarDrafts } from '../services/avatarStorage';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'user-avatar-draft-cleanup';
const JOB_NAME = 'user-avatar-draft-cleanup';
const DAILY_CRON = jobSchedule('user-avatar-draft-cleanup');
const BATCH_SIZE = 500;
let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

function getQueue(): Queue {
  if (!cleanupQueue) cleanupQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return cleanupQueue;
}

export function createUserAvatarDraftCleanupWorker(): Worker {
  return new Worker(QUEUE_NAME, async (job: Job) => {
    if (job.name !== JOB_NAME) throw new Error(`Unknown user avatar draft cleanup job: ${job.name}`);
    let deleted = 0;
    while (true) {
      const batch = await runOutsideDbContext(() => withSystemDbAccessContext(() => cleanupExpiredAvatarDrafts(BATCH_SIZE)));
      deleted += batch;
      if (batch < BATCH_SIZE) break;
    }
    return { deleted };
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

export async function scheduleUserAvatarDraftCleanup(queue: Queue = getQueue()): Promise<void> {
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(JOB_NAME, {}, { jobId: JOB_NAME, repeat: { pattern: DAILY_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 25 } });
}

export async function initializeUserAvatarDraftCleanupWorker(): Promise<void> {
  if (cleanupWorker) return;
  cleanupWorker = createUserAvatarDraftCleanupWorker();
  attachWorkerObservability(cleanupWorker, 'userAvatarDraftCleanup');
  cleanupWorker.on('error', (error) => { console.error('[UserAvatarDraftCleanup] Worker error:', error); captureException(error); });
  cleanupWorker.on('failed', (job, error) => { console.error(`[UserAvatarDraftCleanup] Job ${job?.id} failed:`, error); captureException(error); });
  await scheduleUserAvatarDraftCleanup();
}

export async function shutdownUserAvatarDraftCleanupWorker(): Promise<void> {
  if (cleanupWorker) { await cleanupWorker.close(); cleanupWorker = null; }
  if (cleanupQueue) { await cleanupQueue.close(); cleanupQueue = null; }
}
