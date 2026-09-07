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

type WarrantyJobData = SyncSingleJob | SyncBatchJob;

export function getWarrantyQueue(): Queue {
  if (!warrantyQueue) {
    warrantyQueue = createInstrumentedQueue(WARRANTY_QUEUE);
  }
  return warrantyQueue;
}

function createWarrantyWorker(): Worker<WarrantyJobData> {
  return new Worker<WarrantyJobData>(
    WARRANTY_QUEUE,
    async (job: Job<WarrantyJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'sync-single':
            await syncWarrantyForDevice(job.data.deviceId, { force: job.data.force === true });
            return { deviceId: job.data.deviceId };

          case 'sync-batch': {
            const deviceIds = await getDevicesNeedingWarrantySync(50);
            if (deviceIds.length === 0) {
              return { synced: 0 };
            }
            await syncWarrantyBatch(deviceIds);
            console.log(`[WarrantyWorker] Batch synced ${deviceIds.length} devices`);
            return { synced: deviceIds.length };
          }

          default:
            throw new Error(`Unknown warranty job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
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
