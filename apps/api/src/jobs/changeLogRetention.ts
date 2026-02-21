/**
 * Change Log Retention Worker
 *
 * BullMQ worker that prunes old device change log entries.
 * Default retention: 90 days (configurable via CHANGE_LOG_RETENTION_DAYS env var).
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { deviceChangeLog } from '../db/schema';
import { lt } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    console.error('[ChangeLogRetention] withSystemDbAccessContext is not available — running without access context');
  }
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const QUEUE_NAME = 'change-log-retention';
const DEFAULT_RETENTION_DAYS = parseInt(process.env.CHANGE_LOG_RETENTION_DAYS || '90', 10);

let retentionQueue: Queue | null = null;

export function getChangeLogRetentionQueue(): Queue {
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

export function createChangeLogRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const startTime = Date.now();
        const retentionDays = Math.max(1, job.data.retentionDays ?? DEFAULT_RETENTION_DAYS);
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const result = await db
          .delete(deviceChangeLog)
          .where(lt(deviceChangeLog.createdAt, cutoff));

        const raw = result as unknown as Record<string, unknown>;
        const deletedCount = typeof raw?.rowCount === 'number'
          ? raw.rowCount
          : typeof raw?.count === 'number'
            ? raw.count
            : Array.isArray(result) ? (result as unknown[]).length : 'unknown';

        const durationMs = Date.now() - startTime;
        console.log(`[ChangeLogRetention] Pruned ${deletedCount} rows older than ${retentionDays} days in ${durationMs}ms`);

        return { durationMs, deletedCount };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeChangeLogRetention(): Promise<void> {
  try {
    retentionWorker = createChangeLogRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[ChangeLogRetention] Worker error:', error);
    });

    const queue = getChangeLogRetentionQueue();

    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      {
        repeat: { every: 24 * 60 * 60 * 1000 },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[ChangeLogRetention] Retention worker initialized');
  } catch (error) {
    console.error('[ChangeLogRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownChangeLogRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

