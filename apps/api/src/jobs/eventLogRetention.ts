/**
 * Event Log Retention Worker
 *
 * BullMQ worker that prunes old event log entries.
 * Default retention: 30 days.
 */

import { Queue, Worker, Job } from 'bullmq';
import { db } from '../db';
import { deviceEventLogs } from '../db/schema';
import { lt } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';

const QUEUE_NAME = 'event-log-retention';
const DEFAULT_RETENTION_DAYS = 30;

let retentionQueue: Queue | null = null;

export function getEventLogRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection()
    });
  }
  return retentionQueue;
}

interface RetentionJobData {
  retentionDays?: number;
}

export function createEventLogRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      const startTime = Date.now();
      const retentionDays = job.data.retentionDays || DEFAULT_RETENTION_DAYS;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      const result = await db
        .delete(deviceEventLogs)
        .where(lt(deviceEventLogs.timestamp, cutoff));

      const durationMs = Date.now() - startTime;
      console.log(`[EventLogRetention] Pruned events older than ${retentionDays} days in ${durationMs}ms`);

      return { durationMs };
    },
    {
      connection: getRedisConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeEventLogRetention(): Promise<void> {
  try {
    retentionWorker = createEventLogRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[EventLogRetention] Worker error:', error);
    });

    const queue = getEventLogRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Schedule daily cleanup at midnight
    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      {
        repeat: {
          every: 24 * 60 * 60 * 1000 // Every 24 hours
        },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[EventLogRetention] Retention worker initialized');
  } catch (error) {
    console.error('[EventLogRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownEventLogRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
