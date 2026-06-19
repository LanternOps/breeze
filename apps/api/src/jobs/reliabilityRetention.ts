/**
 * Reliability History Retention Worker
 *
 * BullMQ worker that prunes old reliability history entries.
 * Default retention: 120 days (configurable via RELIABILITY_HISTORY_RETENTION_DAYS).
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[ReliabilityRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'reliability-history-retention';
const JOB_NAME = 'reliability-history-retention';
const REPEAT_JOB_ID = 'reliability-history-retention';
const DEFAULT_RETENTION_DAYS = Math.max(30, parseInt(process.env.RELIABILITY_HISTORY_RETENTION_DAYS || '120', 10));
const BATCH_SIZE = Math.max(1, parseInt(process.env.RELIABILITY_HISTORY_RETENTION_BATCH_SIZE || '10000', 10));
const MAX_BATCHES = Math.max(1, parseInt(process.env.RELIABILITY_HISTORY_RETENTION_MAX_BATCHES || '50', 10));

type RetentionJobData = {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
};

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function extractReliabilityRetentionRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? result.length : 0;
}

export async function pruneReliabilityHistory(options: {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}) {
  const retentionDays = Math.max(30, options.retentionDays);
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? MAX_BATCHES);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const startedAt = Date.now();

  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    const result = await db.execute(sql`
      DELETE FROM device_reliability_history
      WHERE ctid IN (
        SELECT ctid
        FROM device_reliability_history
        WHERE collected_at < ${cutoff}::timestamptz
        LIMIT ${batchSize}
      )
    `);
    lastBatchDeleted = extractReliabilityRetentionRowCount(result);
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  const durationMs = Date.now() - startedAt;
  return {
    retentionDays,
    deleted,
    batches,
    batchSize,
    maxBatches,
    hasMore: batches >= maxBatches && lastBatchDeleted >= batchSize,
    durationMs,
  };
}

export function getReliabilityRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, {
      connection: getBullMQConnection()
    });
  }
  return retentionQueue;
}

export function createReliabilityRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const result = await pruneReliabilityHistory({
          retentionDays: job.data.retentionDays ?? DEFAULT_RETENTION_DAYS,
          batchSize: job.data.batchSize,
          maxBatches: job.data.maxBatches,
        });
        console.log(
          `[ReliabilityRetention] Pruned ${result.deleted} reliability history rows older than ${result.retentionDays} days (batches=${result.batches}, hasMore=${result.hasMore}) in ${result.durationMs}ms`
        );
        return result;
      });
    },
    {
      connection: getBullMQConnection(),
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
      JOB_NAME,
      { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        jobId: REPEAT_JOB_ID,
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

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  BATCH_SIZE,
  MAX_BATCHES,
  DEFAULT_RETENTION_DAYS,
};
