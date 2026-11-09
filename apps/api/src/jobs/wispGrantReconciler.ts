/**
 * Wisp W02 — 5-minute grant reconciler (Wisp design §4.4).
 *
 * Pull half of the grant lifecycle (services/wisp/grantLifecycle.ts): pauses
 * grants whose grantor lost standing, lifts pauses it set itself once the
 * standing recovers, and expires grants past `expires_at`. The push half is
 * the permission-change listener installed at boot.
 *
 * W2 (#11085): each tick also re-sweeps device-troubleshooting runs settled in
 * the last 24 h whose thread post is missing (services/wisp/specialistResult.ts).
 * #10402: and new grants whose first-look post is missing or now due, including
 * #11145's post for a batch where nothing was looked at
 * (services/wisp/firstLook.ts). Both halves are best-effort: a failure is
 * reported, never fails the tick.
 *
 * The processor checks `wispEnabled()` on every tick and returns without
 * touching the database when Wisp is off, so the flag can flip without a
 * restart.
 */
import { Job, Queue, Worker } from 'bullmq';
import { wispEnabled } from '../config/env';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { resweepFirstLookPosts } from '../services/wisp/firstLook';
import { reconcileActiveGrants } from '../services/wisp/grantLifecycle';
import { resweepSpecialistResults } from '../services/wisp/specialistResult';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'wisp-grant-reconciler';
const JOB_NAME = 'reconcile';
// Sub-hourly: `every:` per scheduleRegistry.ts, not a cron pattern.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

type ReconcileJobData = { type: 'reconcile'; queuedAt: string };

let reconcilerQueue: Queue<ReconcileJobData> | null = null;
let reconcilerWorker: Worker<ReconcileJobData> | null = null;

export async function processWispGrantReconcile(): Promise<
  | { skipped: true }
  | { skipped: false; scanned: number; paused: number; resumed: number; expired: number; failed: number; specialistPosts: number; firstLookPosts: number }
> {
  if (!wispEnabled()) return { skipped: true };
  const now = new Date();
  const result = await reconcileActiveGrants(now);
  let specialistPosts = 0;
  try {
    const swept = await resweepSpecialistResults(now);
    specialistPosts = swept.posted;
    if (swept.posted || swept.failed) {
      console.log(`[WispGrantReconciler] specialist posts scanned=${swept.scanned} posted=${swept.posted} failed=${swept.failed}`);
    }
  } catch (err) {
    console.error('[WispGrantReconciler] specialist post re-sweep failed', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
  let firstLookPosts = 0;
  try {
    const swept = await resweepFirstLookPosts(now);
    firstLookPosts = swept.posted;
    const nothingLookedAt = swept.skipped.nothing_looked_at ?? 0;
    if (swept.posted || swept.failed || nothingLookedAt) {
      console.log(`[WispGrantReconciler] first-look posts scanned=${swept.scanned} posted=${swept.posted} couldntLook=${swept.couldntLook} failed=${swept.failed} nothingLookedAt=${nothingLookedAt}`);
    }
  } catch (err) {
    console.error('[WispGrantReconciler] first-look post re-sweep failed', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
  if (result.paused || result.resumed || result.expired || result.failed) {
    console.log(`[WispGrantReconciler] scanned=${result.scanned} paused=${result.paused} resumed=${result.resumed} expired=${result.expired} failed=${result.failed}`);
  }
  // Per-grant failures are captured individually; a sweep where EVERY grant
  // failed (schema drift, evaluator down) fails the job so it is visible.
  if (result.scanned > 0 && result.failed === result.scanned) {
    throw new Error(`[WispGrantReconciler] every grant failed to reconcile (${result.failed}/${result.scanned})`);
  }
  return { skipped: false, ...result, specialistPosts, firstLookPosts };
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
