import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { getRedisConnection } from './redis';
import { syncWarrantyForDevice, syncWarrantyBatch, getDevicesNeedingWarrantySync } from './warrantySync';

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
}

interface SyncBatchJob {
  type: 'sync-batch';
}

type WarrantyJobData = SyncSingleJob | SyncBatchJob;

export function getWarrantyQueue(): Queue {
  if (!warrantyQueue) {
    warrantyQueue = new Queue(WARRANTY_QUEUE, {
      connection: getRedisConnection(),
    });
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
            await syncWarrantyForDevice(job.data.deviceId);
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
      connection: getRedisConnection(),
      concurrency: 3,
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

  // Schedule batch sync every 6 hours
  await queue.add(
    'sync-batch',
    { type: 'sync-batch' },
    {
      repeat: {
        every: 6 * 60 * 60 * 1000, // 6 hours
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );

  console.log('[WarrantyWorker] Scheduled repeatable warranty sync jobs');
}

export async function queueWarrantySyncForDevice(deviceId: string): Promise<void> {
  const queue = getWarrantyQueue();
  await queue.add(
    'sync-single',
    { type: 'sync-single', deviceId },
    {
      jobId: `warranty-single-${deviceId}`,
      removeOnComplete: true,
      removeOnFail: { count: 20 },
    }
  );
}

export async function initializeWarrantyWorker(): Promise<void> {
  try {
    warrantyWorker = createWarrantyWorker();

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
