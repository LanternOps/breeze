/**
 * Reliability History Retention Worker
 *
 * BullMQ worker that prunes old reliability history entries.
 * Default retention: 120 days (configurable via RELIABILITY_HISTORY_RETENTION_DAYS).
 */

import { Job, Queue, Worker } from 'bullmq';
import { lt } from 'drizzle-orm';

import * as dbModule from '../db';
import { deviceReliabilityHistory } from '../db/schema';
import { getRedisConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[ReliabilityRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'reliability-history-retention';
const DEFAULT_RETENTION_DAYS = Math.max(30, parseInt(process.env.RELIABILITY_HISTORY_RETENTION_DAYS || '120', 10));

type RetentionJobData = {
  retentionDays?: number;
};

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getReliabilityRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, {
      connection: getRedisConnection()
    });
  }
  return retentionQueue;
}

export function createReliabilityRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const retentionDays = Math.max(30, job.data.retentionDays ?? DEFAULT_RETENTION_DAYS);
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const startedAt = Date.now();

        await db
          .delete(deviceReliabilityHistory)
          .where(lt(deviceReliabilityHistory.collectedAt, cutoff));

        const durationMs = Date.now() - startedAt;
        console.log(`[ReliabilityRetention] Pruned reliability history older than ${retentionDays} days in ${durationMs}ms`);
        return { retentionDays, durationMs };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1
    }
  );
}

export async function initializeReliabilityRetention(): Promise<void> {
  try {
    retentionWorker = createReliabilityRetentionWorker();
    retentionWorker.on('error', (error) => {
      console.error('[ReliabilityRetention] Worker error:', error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`[ReliabilityRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
      captureException(error);
    });

    const queue = getReliabilityRetentionQueue();
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
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

    console.log('[ReliabilityRetention] Retention worker initialized');
  } catch (error) {
    console.error('[ReliabilityRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownReliabilityRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}
