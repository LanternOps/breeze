import { Queue, Worker, type Job } from 'bullmq';

import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { refreshLearnedNetworkLastSeen, runLearnedNetworkRetention } from '../services/learnedNetworks/maintenance';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

/**
 * Learned networks W01b (#12369, index E4): one queue, two schedulers. `refresh-last-seen` runs hourly and copies
 * device confirmations out to the shared rows; `retention` runs daily and applies spec §6's limits.
 */

const LOG_PREFIX = '[LearnedNetworkMaintenance]';
const QUEUE_NAME = 'learned-network-maintenance';
const REFRESH_JOB = 'refresh-last-seen';
const RETENTION_JOB = 'retention';

let queue: Queue | null = null;
let worker: Worker | null = null;

export function getLearnedNetworkMaintenanceQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

async function processLearnedNetworkMaintenance(job: Job | { name: string }): Promise<unknown> {
  // No context wrapper: each batch opens its own system context (services/learnedNetworks/maintenance.ts).
  switch (job.name) {
    case REFRESH_JOB:
      return refreshLearnedNetworkLastSeen(new Date());
    case RETENTION_JOB:
      return runLearnedNetworkRetention(new Date());
    default:
      throw new Error(`${LOG_PREFIX} unknown job name ${job.name}`);
  }
}

export async function initializeLearnedNetworkMaintenance(): Promise<void> {
  try {
    worker = new Worker(QUEUE_NAME, processLearnedNetworkMaintenance, {
      connection: getBullMQConnection(), concurrency: 1,
    });
    attachWorkerObservability(worker, 'learnedNetworkMaintenance');
    worker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    worker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.name} ${job?.id} failed:`, error);
      captureException(error);
    });

    // Cron slots from the registry, never `every:` (epoch-anchored).
    const q = getLearnedNetworkMaintenanceQueue();
    await q.upsertJobScheduler('learned-network-last-seen', { pattern: jobSchedule('learned-network-last-seen') }, {
      name: REFRESH_JOB, data: {}, opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
    });
    await q.upsertJobScheduler('learned-network-retention', { pattern: jobSchedule('learned-network-retention') }, {
      name: RETENTION_JOB, data: {}, opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
    });

    console.log(`${LOG_PREFIX} Worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownLearnedNetworkMaintenance(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
