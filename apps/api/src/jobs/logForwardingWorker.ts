/**
 * Log Forwarding Worker
 *
 * BullMQ worker that forwards device event logs to external destinations
 * (e.g. Elasticsearch) based on per-org forwarding configuration.
 * Includes backpressure protection to avoid overwhelming the queue.
 */

import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '../services/redis';
import { bulkIndexEvents, clearClientCache } from '../services/logForwarding';

const QUEUE_NAME = 'log-forwarding';

interface LogForwardingJobData {
  orgId: string;
  deviceId: string;
  hostname: string;
  events: Array<{
    category: string;
    level: string;
    source: string;
    message: string;
    timestamp: string;
    rawData?: unknown;
  }>;
}

let queue: Queue<LogForwardingJobData> | null = null;
let worker: Worker<LogForwardingJobData> | null = null;

export function getLogForwardingQueue(): Queue<LogForwardingJobData> {
  if (!queue) {
    queue = new Queue<LogForwardingJobData>(QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
  }
  return queue;
}

export async function enqueueLogForwarding(data: LogForwardingJobData): Promise<void> {
  const q = getLogForwardingQueue();

  // Backpressure: skip if queue is overwhelmed
  const waiting = await q.getWaitingCount();
  if (waiting > 10000) {
    console.warn(`[logForwarding] Queue depth ${waiting} exceeds 10k, skipping enqueue for org ${data.orgId}`);
    return;
  }

  await q.add('forward-events', data, {
    jobId: `fwd:${data.deviceId}:${Date.now()}`,
  });
}

export async function initializeLogForwardingWorker(): Promise<void> {
  worker = new Worker<LogForwardingJobData>(
    QUEUE_NAME,
    async (job: Job<LogForwardingJobData>) => {
      const { orgId, deviceId, hostname, events } = job.data;

      const docs = events.map((e) => ({
        deviceId,
        orgId,
        hostname,
        category: e.category,
        level: e.level,
        source: e.source,
        message: e.message,
        timestamp: e.timestamp,
        rawData: e.rawData,
      }));

      const result = await bulkIndexEvents(orgId, docs);
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on('error', (error) => {
    console.error('[logForwarding] Worker error:', error);
  });

  worker.on('failed', (job, err) => {
    console.error(`[logForwarding] Job ${job?.id} failed:`, err.message);
  });

  console.log('[logForwarding] Worker started');
}

export async function shutdownLogForwardingWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  clearClientCache();
}
