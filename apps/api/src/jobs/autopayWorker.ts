import { captureException } from '../services/sentry';
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
  let result: { sent: number; failed: number } | undefined;
  let dispatchError: unknown;
  try {
    result = await dispatchPendingBillingNotices();
    if (result.failed) console.error('[autopayWorker] notice dispatch failures', result);
  } catch (error) {
    dispatchError = error;
    console.error('[autopayWorker] dispatch failed', { phase: 'dispatch' });
    captureException(error, undefined, { service: 'autopayWorker', autopay_phase: 'dispatch' });
  }
  // Merge only queues removed methods. Worker ticks own all network drains.
  try { await drainAutopayMethodDetaches(); }
  catch (error) {
    console.error('[autopayWorker] detach drain failed', { phase: 'detach' });
    captureException(error, undefined, { service: 'autopayWorker', autopay_phase: 'detach' });
  }
  if (!result) throw dispatchError;
  return result;
}

export async function initializeAutopayWorkers(): Promise<void> {
  if (worker) return;
  let pendingQueue: Queue<AutopayJobData> | null = null;
  let pendingWorker: Worker<AutopayJobData> | null = null;
  try {
    pendingQueue = new Queue<AutopayJobData>('autopay-jobs', { connection: getBullMQConnection() });
    pendingWorker = new Worker<AutopayJobData>('autopay-jobs', async (job: Job<AutopayJobData>) => {
      if (job.data.type !== 'notice-dispatch') throw new Error(`Unknown autopay job: ${job.name}`);
      return processNoticeDispatch();
    }, { connection: getBullMQConnection(), concurrency: 1 });
    attachWorkerObservability(pendingWorker, 'autopayWorker');
    pendingWorker.on('error', error => console.error('[autopayWorker]', error));
    await pendingQueue.add('notice-dispatch', { type: 'notice-dispatch' }, {
      jobId: 'billing-notice-dispatch',
      repeat: { pattern: jobSchedule('billing-notice-dispatch'), tz: 'UTC' },
      removeOnComplete: { count: 10 }, removeOnFail: { count: 50 },
    });
    queue = pendingQueue;
    worker = pendingWorker;
  } catch (error) {
    await Promise.allSettled([
      ...(pendingWorker ? [pendingWorker.close()] : []),
      ...(pendingQueue ? [pendingQueue.close()] : []),
    ]);
    throw error;
  }
}

export async function shutdownAutopayWorkers(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
