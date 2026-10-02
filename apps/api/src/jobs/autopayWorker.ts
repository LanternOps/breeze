import { Queue, Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { dispatchPendingBillingNotices } from '../services/autopay/noticeOutbox';
import { drainAutopayMethodDetaches } from '../services/autopay/merge';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

type AutopayJobData = { type: 'notice-dispatch' };
let queue: Queue<AutopayJobData> | null = null;
let worker: Worker<AutopayJobData> | null = null;

export async function processNoticeDispatch(): Promise<{ sent: number; failed: number }> {
  const result = await dispatchPendingBillingNotices();
  // Removed method rows form the durable detach queue; retry post-commit failures.
  await drainAutopayMethodDetaches();
  return result;
}

export async function initializeAutopayWorkers(): Promise<void> {
  if (worker) return;
  queue = new Queue<AutopayJobData>('autopay-jobs', { connection: getBullMQConnection() });
  worker = new Worker<AutopayJobData>('autopay-jobs', async (job: Job<AutopayJobData>) => {
    if (job.data.type !== 'notice-dispatch') throw new Error(`Unknown autopay job: ${job.name}`);
    return processNoticeDispatch();
  }, { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'autopayWorker');
  worker.on('error', error => console.error('[autopayWorker]', error));
  await queue.add('notice-dispatch', { type: 'notice-dispatch' }, {
    jobId: 'billing-notice-dispatch',
    repeat: { pattern: jobSchedule('billing-notice-dispatch'), tz: 'UTC' },
    removeOnComplete: { count: 10 }, removeOnFail: { count: 50 },
  });
}

export async function shutdownAutopayWorkers(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
