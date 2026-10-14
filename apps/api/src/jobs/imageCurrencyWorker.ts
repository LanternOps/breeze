// apps/api/src/jobs/imageCurrencyWorker.ts
/**
 * Workload image currency (#3813, W05, spec §9.3): every 30 minutes, one pass
 * compares due container images against their public registries and writes
 * `upstream_status` / `upstream_digest` / `upstream_checked_at` onto each org's
 * own `device_workloads` rows. All the logic lives in
 * `services/imageCurrency/pass.ts`; this file is only the BullMQ wiring.
 *
 * Inert until an org enables the `workload_inventory` feature (default off):
 * with no container rows, a pass scans nothing and makes no request.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { runImageCurrencyPass, type ImageCurrencyPassSummary } from '../services/imageCurrency/pass';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

export const IMAGE_CURRENCY_QUEUE = 'image-currency';
const PASS_JOB = 'image-currency-pass';
// BullMQ 5 rejects ':' in a custom jobId.
const REPEAT_JOB_ID = 'image-currency-pass';
/** Sub-hourly `every:` ticks are exempt from scheduleRegistry by design. */
export const IMAGE_CURRENCY_INTERVAL_MS = 30 * 60_000;
/** A pass can wait on slow registries (bounded per request); keep the lock well clear of it. */
const LOCK_DURATION_MS = 600_000;

export type ImageCurrencyJobData = { type: 'pass' };

let queue: Queue<ImageCurrencyJobData> | null = null;
let worker: Worker<ImageCurrencyJobData> | null = null;

export function getImageCurrencyQueue(): Queue<ImageCurrencyJobData> {
  if (!queue) queue = new Queue<ImageCurrencyJobData>(IMAGE_CURRENCY_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function processImageCurrencyJob(_job: Pick<Job<ImageCurrencyJobData>, 'data'>): Promise<ImageCurrencyPassSummary> {
  return runImageCurrencyPass();
}

async function scheduleImageCurrencyPass(): Promise<void> {
  const q = getImageCurrencyQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(PASS_JOB, { type: 'pass' }, {
    jobId: REPEAT_JOB_ID,
    repeat: { every: IMAGE_CURRENCY_INTERVAL_MS },
    // The next tick is 30 minutes away and every row stays due until written:
    // a failed pass needs no BullMQ retry.
    attempts: 1,
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}

export async function initializeImageCurrencyWorker(): Promise<void> {
  worker = new Worker<ImageCurrencyJobData>(IMAGE_CURRENCY_QUEUE, processImageCurrencyJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
    lockDuration: LOCK_DURATION_MS,
  });
  attachWorkerObservability(worker, 'imageCurrencyWorker');
  worker.on('error', (error) => {
    console.error('[imageCurrency] worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[imageCurrency] job ${job?.id ?? '?'} failed:`, error);
    captureException(error);
  });
  await scheduleImageCurrencyPass();
}

export async function shutdownImageCurrencyWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
