import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection } from './redis';
import { createInstrumentedQueue } from './bullmqQueue';
import { syncWarrantyForDevice, syncWarrantyBatch, getDevicesNeedingWarrantySync } from './warrantySync';
import { jobSchedule } from '../jobs/scheduleRegistry';
import { attachWorkerObservability } from '../jobs/workerObservability';

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const WARRANTY_QUEUE = 'warranty-sync';

let warrantyQueue: Queue | null = null;
let warrantyWorker: Worker | null = null;

interface SyncSingleJob {
  type: 'sync-single';
  deviceId: string;
  /** Explicit user-requested refresh; bypasses the virtual-machine skip. */
  force?: boolean;
}

interface SyncBatchJob {
  type: 'sync-batch';
}

export type WarrantyJobData = SyncSingleJob | SyncBatchJob;

export function getWarrantyQueue(): Queue {
  if (!warrantyQueue) {
    warrantyQueue = createInstrumentedQueue(WARRANTY_QUEUE);
  }
  return warrantyQueue;
}

export async function processWarrantyJob(data: WarrantyJobData): Promise<Record<string, unknown>> {
  switch (data.type) {
    case 'sync-single':
      return runWithSystemDbAccess(async () => {
        await syncWarrantyForDevice(data.deviceId, { force: data.force === true });
        return { deviceId: data.deviceId };
      });

    case 'sync-batch': {
      // #4622 — subjects, not device ids: the sweep now covers manual
      // assets with a manufacturer + serial alongside agent devices.
      const subjects = await runWithSystemDbAccess(() => getDevicesNeedingWarrantySync(50));
      if (subjects.length === 0) {
        return { synced: 0, failed: 0 };
      }
      // #10403 — NOT inside the select's context: syncWarrantyBatch opens one
      // transaction per subject, because the partner-export lock hierarchy
      // cannot hold across orgs of different partners in one transaction.
      const { synced, failed } = await syncWarrantyBatch(subjects);
      if (synced === 0) {
        // Nothing on the page committed: a systemic fault (each subject was
        // already captured). Fail the job so it shows as failed, not completed.
        throw new Error(`[WarrantyWorker] Batch sync: all ${subjects.length} subjects failed`);
      }
      console.log(`[WarrantyWorker] Batch synced ${synced}/${subjects.length} warranty subjects (${failed} failed)`);
      return { synced, failed };
    }

    default:
      throw new Error(`Unknown warranty job type: ${(data as { type: string }).type}`);
  }
}

function createWarrantyWorker(): Worker<WarrantyJobData> {
  return new Worker<WarrantyJobData>(
    WARRANTY_QUEUE,
    async (job: Job<WarrantyJobData>) => processWarrantyJob(job.data),
    {
      connection: getBullMQConnection(),
      concurrency: 3,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

async function scheduleWarrantyJobs(): Promise<void> {
  const queue = getWarrantyQueue();

  // Remove existing repeatable jobs
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Every 6h at a registry-allocated slot (jobs/scheduleRegistry.ts).
  await queue.add(
    'sync-batch',
    { type: 'sync-batch' },
    {
      repeat: { pattern: jobSchedule('warranty-batch-sync') },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );

  console.log('[WarrantyWorker] Scheduled repeatable warranty sync jobs');
}

export async function queueWarrantySyncForDevice(
  deviceId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const queue = getWarrantyQueue();
  const force = options.force === true;
  await queue.add(
    'sync-single',
    { type: 'sync-single', deviceId, ...(force ? { force: true } : {}) },
    {
      // Forced refreshes get their OWN jobId. The id is stable so duplicate
      // enqueues collapse, but a forced job must not collapse into a pending
      // background one: BullMQ would drop the newer job and the user's refresh
      // would silently never run with `force`.
      jobId: force ? `warranty-single-${deviceId}-force` : `warranty-single-${deviceId}`,
      removeOnComplete: true,
      removeOnFail: { count: 20 },
    }
  );
}

export async function initializeWarrantyWorker(): Promise<void> {
  try {
    warrantyWorker = createWarrantyWorker();
  attachWorkerObservability(warrantyWorker, 'warrantyWorker');

    warrantyWorker.on('error', (error) => {
      console.error('[WarrantyWorker] Worker error:', error);
    });

    warrantyWorker.on('failed', (job, error) => {
      console.error(`[WarrantyWorker] Job ${job?.id} failed:`, error);
    });

    await scheduleWarrantyJobs();

    console.log('[WarrantyWorker] Warranty worker initialized');
  } catch (error) {
    console.error('[WarrantyWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownWarrantyWorker(): Promise<void> {
  if (warrantyWorker) {
    await warrantyWorker.close();
    warrantyWorker = null;
  }
  if (warrantyQueue) {
    await warrantyQueue.close();
    warrantyQueue = null;
  }
  console.log('[WarrantyWorker] Warranty worker shut down');
}
