/**
 * IP History Retention Worker
 *
 * BullMQ worker that prunes inactive IP history rows after a retention period.
 * Default retention: 90 days (configurable via IP_HISTORY_RETENTION_DAYS env var).
 */

import { Queue, Worker, Job } from 'bullmq';
import { and, eq, lte } from 'drizzle-orm';
import * as dbModule from '../db';
import { deviceIpHistory } from '../db/schema';
import { getRedisConnection } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'ip-history-retention';
const DEFAULT_RETENTION_DAYS = parseInt(process.env.IP_HISTORY_RETENTION_DAYS || '90', 10);

let retentionQueue: Queue | null = null;

export function getIPHistoryRetentionQueue(): Queue {
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

export function createIPHistoryRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const startTime = Date.now();
        const retentionDays = Math.max(1, job.data.retentionDays ?? DEFAULT_RETENTION_DAYS);
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const deleted = await db
          .delete(deviceIpHistory)
          .where(
            and(
              eq(deviceIpHistory.isActive, false),
              lte(deviceIpHistory.deactivatedAt, cutoff)
            )
          )
          .returning({ id: deviceIpHistory.id });

        const durationMs = Date.now() - startTime;
        console.log(`[IPHistoryRetention] Pruned ${deleted.length} inactive rows older than ${retentionDays} days in ${durationMs}ms`);

        return { durationMs, deletedCount: deleted.length };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeIPHistoryRetention(): Promise<void> {
  try {
    retentionWorker = createIPHistoryRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[IPHistoryRetention] Worker error:', error);
    });

    const queue = getIPHistoryRetentionQueue();

    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      {
        repeat: {
          every: 24 * 60 * 60 * 1000
        },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[IPHistoryRetention] Retention worker initialized');
  } catch (error) {
    console.error('[IPHistoryRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownIPHistoryRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
