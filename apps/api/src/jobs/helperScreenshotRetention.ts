import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import {
  deleteExpiredScreenshots,
  sweepOrphanedScreenshotFiles,
  type OrphanSweepResult,
} from '../services/screenshotStorage';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

/**
 * Helper screenshot expiry sweep.
 *
 * `deleteExpiredScreenshots` (services/screenshotStorage.ts) existed with no
 * caller: `expiresAt` was set on every row but nothing ever enforced it, so
 * every screenshot lived until an operator noticed. Paired with the per-device
 * storage quota in screenshotStorage.ts, this is what actually reclaims the
 * space once a device's screenshots age out, keeping the shared
 * `SCREENSHOT_STORAGE_DIR` bounded over time rather than only per-device at
 * any instant.
 */

export const HELPER_SCREENSHOT_RETENTION_QUEUE = 'helper-screenshot-retention';
const JOB_NAME = 'sweep-expired-helper-screenshots';

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(HELPER_SCREENSHOT_RETENTION_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/**
 * One retention run: expire rows past `expires_at` (and their files), then
 * remove files no row references (#8117) — leftovers from delete paths that
 * could not unlink, and files orphaned before those paths removed them.
 * Exported for tests.
 */
export async function runHelperScreenshotRetentionOnce(): Promise<{
  deleted: number;
  orphans: OrphanSweepResult;
}> {
  const deleted = await deleteExpiredScreenshots();
  if (deleted > 0) {
    console.log(`[helperScreenshotRetention] swept ${deleted} expired screenshot(s)`);
  }
  const orphans = await sweepOrphanedScreenshotFiles();
  if (orphans.removed > 0 || orphans.directoriesRemoved > 0) {
    console.log(
      `[helperScreenshotRetention] removed ${orphans.removed} orphaned screenshot file(s) `
      + `and ${orphans.directoriesRemoved} empty director${orphans.directoriesRemoved === 1 ? 'y' : 'ies'}`,
    );
  }
  return { deleted, orphans };
}

async function processJob(_job: Job): Promise<unknown> {
  return runHelperScreenshotRetentionOnce();
}

async function scheduleRepeatableJob(): Promise<void> {
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) {
    if (job.name === JOB_NAME) await q.removeRepeatableByKey(job.key);
  }
  await q.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: HELPER_SCREENSHOT_RETENTION_QUEUE,
      // String literal, not the exported const: the schedule contract test
      // statically resolves `jobSchedule('<literal>')` only.
      repeat: { pattern: jobSchedule('helper-screenshot-retention') },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeHelperScreenshotRetentionWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(HELPER_SCREENSHOT_RETENTION_QUEUE, processJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'helperScreenshotRetention');
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await worker.close();
    worker = null;
    throw err;
  }
  console.log('[helperScreenshotRetention] Initialized');
}

export async function shutdownHelperScreenshotRetentionWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
