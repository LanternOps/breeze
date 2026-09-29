import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { pruneInCtidBatches, warnOnRetentionBacklog } from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
const QUEUE_NAME = 'time-sync-retention';
let queue: Queue | null = null;
let worker: Worker | null = null;
export async function runTimeSyncRetention() {
  const result = await pruneInCtidBatches({
    table: 'device_time_daily',
    where: sql`day < current_date - 400`,
    batchSize: 10000,
    maxBatches: 100,
    label: 'timeSyncRetention.daily',
  });
  warnOnRetentionBacklog('[time-sync]', 'device_time_daily', result);
  return result;
}
export async function initializeTimeSyncRetention(): Promise<void> {
  queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  worker = new Worker(QUEUE_NAME, () => runTimeSyncRetention(), {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'timeSyncRetention');
  worker.on('error', (error) =>
    console.error('[time-sync] retention worker failed', error),
  );
  for (const job of await queue.getRepeatableJobs())
    await queue.removeRepeatableByKey(job.key);
  await queue.add(
    'cleanup',
    {},
    {
      repeat: { pattern: jobSchedule('time-sync-retention') },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    },
  );
}
export async function shutdownTimeSyncRetention(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
