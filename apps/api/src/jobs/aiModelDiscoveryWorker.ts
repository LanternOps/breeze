// apps/api/src/jobs/aiModelDiscoveryWorker.ts
/**
 * AI model registry (#7598) discovery queue. W01: `sync-platform` (daily,
 * manual "Refresh", and once shortly after boot). W03 adds
 * `sync-connection:{id}` for BYOK keys.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { syncPlatformModels, type SyncReport } from '../services/aiModels/discovery';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

export const AI_MODEL_DISCOVERY_QUEUE = 'ai-model-discovery';
export const SYNC_PLATFORM_JOB = 'sync-platform';

// BullMQ 5 rejects ':' in a custom jobId.
const DAILY_REPEAT_JOB_ID = 'ai-model-discovery-sync-platform-daily';
const MANUAL_JOB_ID = 'ai-model-discovery-sync-platform-manual';
const BOOT_JOB_ID = 'ai-model-discovery-sync-platform-boot';
const DAILY_CRON = jobSchedule('ai-model-discovery-sync');
const BOOT_DELAY_MS = 60_000;

export type AiModelDiscoveryJobData = { type: 'sync-platform'; trigger: 'schedule' | 'manual' | 'boot' };

let queue: Queue<AiModelDiscoveryJobData> | null = null;
let worker: Worker<AiModelDiscoveryJobData> | null = null;

export function getAiModelDiscoveryQueue(): Queue<AiModelDiscoveryJobData> {
  if (!queue) queue = new Queue<AiModelDiscoveryJobData>(AI_MODEL_DISCOVERY_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function processAiModelDiscoveryJob(job: Pick<Job<AiModelDiscoveryJobData>, 'data'>): Promise<SyncReport> {
  if (job.data.type !== 'sync-platform') {
    throw new Error(`Unknown ai-model-discovery job type: ${String((job.data as { type?: unknown }).type)}`);
  }
  const report = await syncPlatformModels();
  // A failed listing changed nothing (spec §6). Throwing lets BullMQ retry with backoff.
  if (report.status === 'failed') throw new Error(`Platform model sync failed: ${report.error}`);
  if (report.status === 'skipped') console.info(`[aiModelDiscovery] platform sync skipped: ${report.reason}`);
  return report;
}

export async function enqueuePlatformModelSync(trigger: 'manual' | 'boot' = 'manual'): Promise<{ id: string }> {
  return enqueueOrReplaceStale(
    getAiModelDiscoveryQueue() as unknown as Queue,
    SYNC_PLATFORM_JOB,
    trigger === 'manual' ? MANUAL_JOB_ID : BOOT_JOB_ID,
    { type: 'sync-platform', trigger } satisfies AiModelDiscoveryJobData,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
      ...(trigger === 'boot' ? { delay: BOOT_DELAY_MS } : {}),
    },
    '[aiModelDiscovery]',
  );
}

export async function scheduleAiModelDiscoveryJobs(): Promise<void> {
  const q = getAiModelDiscoveryQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(SYNC_PLATFORM_JOB, { type: 'sync-platform', trigger: 'schedule' }, {
    jobId: DAILY_REPEAT_JOB_ID,
    repeat: { pattern: DAILY_CRON },
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}

export async function initializeAiModelDiscoveryWorker(): Promise<void> {
  worker = new Worker<AiModelDiscoveryJobData>(AI_MODEL_DISCOVERY_QUEUE, processAiModelDiscoveryJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'aiModelDiscoveryWorker');
  worker.on('error', (error) => {
    console.error('[aiModelDiscovery] worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[aiModelDiscovery] job ${job?.id ?? '?'} failed:`, error);
    captureException(error);
  });
  await scheduleAiModelDiscoveryJobs();
  await enqueuePlatformModelSync('boot');
}

export async function shutdownAiModelDiscoveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export const __testOnly = { DAILY_REPEAT_JOB_ID, MANUAL_JOB_ID, BOOT_JOB_ID, DAILY_CRON };
