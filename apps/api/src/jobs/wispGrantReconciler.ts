/**
 * Wisp W02 — 5-minute grant reconciler (Wisp design §4.4).
 *
 * Pull half of the grant lifecycle (services/wisp/grantLifecycle.ts): pauses
 * grants whose grantor lost standing, lifts pauses it set itself once the
 * standing recovers, and expires grants past `expires_at`. The push half is
 * the permission-change listener installed at boot.
 *
 * The processor checks `wispEnabled()` on every tick and returns without
 * touching the database when Wisp is off, so the flag can flip without a
 * restart.
 */
import { Job, Queue, Worker } from 'bullmq';
import { wispEnabled } from '../config/env';
import { getBullMQConnection } from '../services/redis';
import { reconcileActiveGrants } from '../services/wisp/grantLifecycle';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'wisp-grant-reconciler';
const JOB_NAME = 'reconcile';
// Sub-hourly: `every:` per scheduleRegistry.ts, not a cron pattern.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

type ReconcileJobData = { type: 'reconcile'; queuedAt: string };

let reconcilerQueue: Queue<ReconcileJobData> | null = null;
let reconcilerWorker: Worker<ReconcileJobData> | null = null;

export async function processWispGrantReconcile(): Promise<
  { skipped: true } | { skipped: false; scanned: number; paused: number; resumed: number; expired: number; failed: number }
> {
  if (!wispEnabled()) return { skipped: true };
  const result = await reconcileActiveGrants(new Date());
  if (result.paused || result.resumed || result.expired || result.failed) {
    console.log(`[WispGrantReconciler] scanned=${result.scanned} paused=${result.paused} resumed=${result.resumed} expired=${result.expired} failed=${result.failed}`);
  }
  // Per-grant failures are captured individually; a sweep where EVERY grant
  // failed (schema drift, evaluator down) fails the job so it is visible.
  if (result.scanned > 0 && result.failed === result.scanned) {
    throw new Error(`[WispGrantReconciler] every grant failed to reconcile (${result.failed}/${result.scanned})`);
  }
  return { skipped: false, ...result };
}

export function getWispGrantReconcilerQueue(): Queue<ReconcileJobData> {
  if (!reconcilerQueue) {
    reconcilerQueue = new Queue<ReconcileJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reconcilerQueue;
}

async function scheduleWispGrantReconcilerJobs(): Promise<void> {
  const queue = getWispGrantReconcilerQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    JOB_NAME,
    { type: 'reconcile', queuedAt: new Date().toISOString() },
    {
      repeat: { every: RECONCILE_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
}

export async function initializeWispGrantReconciler(): Promise<void> {
  try {
    reconcilerWorker = new Worker<ReconcileJobData>(
      QUEUE_NAME,
      async (_job: Job<ReconcileJobData>) => processWispGrantReconcile(),
      { connection: getBullMQConnection(), concurrency: 1 },
    );
    attachWorkerObservability(reconcilerWorker, 'wispGrantReconciler');
    reconcilerWorker.on('error', (error) => console.error('[WispGrantReconciler] Worker error:', error));
    reconcilerWorker.on('failed', (job, error) => console.error(`[WispGrantReconciler] Job ${job?.id} failed:`, error));
    await scheduleWispGrantReconcilerJobs();
    console.log('[WispGrantReconciler] Worker initialized');
  } catch (error) {
    console.error('[WispGrantReconciler] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownWispGrantReconciler(): Promise<void> {
  if (reconcilerWorker) { await reconcilerWorker.close(); reconcilerWorker = null; }
  if (reconcilerQueue) { await reconcilerQueue.close(); reconcilerQueue = null; }
}
