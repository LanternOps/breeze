/**
 * IP History Retention Worker
 *
 * BullMQ worker that prunes inactive IP history rows after a retention period.
 * Default retention: 90 days (configurable via IP_HISTORY_RETENTION_DAYS env var).
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { getRedisConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[IPHistoryRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
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

        const result = await db.execute(sql`
          DELETE FROM device_ip_history
          WHERE is_active = false AND deactivated_at <= ${cutoff}
        `);
        const deletedCount = Number((result as unknown as { count: number }).count ?? result.length ?? 0);

        const durationMs = Date.now() - startTime;
        console.log(`[IPHistoryRetention] Pruned ${deletedCount} inactive rows older than ${retentionDays} days in ${durationMs}ms`);

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

export async function initializeIPHistoryRetention(): Promise<void> {
  try {
    retentionWorker = createIPHistoryRetentionWorker();

    retentionWorker.on('error', (error) => {
      console.error('[IPHistoryRetention] Worker error:', error);
      captureException(error);
    });

    retentionWorker.on('failed', (job, err) => {
      console.error(`[IPHistoryRetention] job ${job?.id} failed:`, err);
      captureException(err);
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
