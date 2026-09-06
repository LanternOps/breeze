/**
 * Change Log Retention Worker
 *
 * BullMQ worker that prunes old device change log entries in bounded ctid
 * batches. Default retention: 90 days (configurable via
 * CHANGE_LOG_RETENTION_DAYS, clamped to 1..365). Batch bounds:
 * CHANGE_LOG_RETENTION_BATCH_SIZE / CHANGE_LOG_RETENTION_MAX_BATCHES.
 *
 * Previously a single unbounded DELETE that held a pooled connection for the
 * whole statement (#4343). Pruning rides `device_change_log_created_at_idx`.
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[ChangeLogRetention]';
const QUEUE_NAME = 'change-log-retention';
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.CHANGE_LOG_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'CHANGE_LOG_RETENTION_BATCH_SIZE', 10000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'CHANGE_LOG_RETENTION_MAX_BATCHES', 200);

let retentionQueue: Queue | null = null;

export function getChangeLogRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection()
    });
  }
  return retentionQueue;
}

interface RetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export function createChangeLogRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper here: pruneInCtidBatches opens one per batch, so that
    // each batch commits and releases its locks (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => {
      const startTime = Date.now();
      const retentionDays = resolveRetentionDays(job.data.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS);
      const batchSize = Math.max(1, job.data.batchSize ?? BATCH_SIZE);
      const maxBatches = Math.max(1, job.data.maxBatches ?? MAX_BATCHES);
      // postgres-js does not coerce JS Date in template-literal params; pass an ISO string.
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

      // Prunes on created_at (ingest time), matching the pre-batching
      // behaviour — NOT the `timestamp` column, which is the observed change
      // time and can predate ingest.
      const { deleted: deletedCount, batches, hasMore } = await pruneInCtidBatches({
        table: 'device_change_log',
        where: sql`created_at < ${cutoff}`,
        batchSize,
        maxBatches,
        label: 'changeLogRetention.prune',
      });

      const durationMs = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Pruned ${deletedCount} rows older than ${retentionDays} days (batches=${batches}) in ${durationMs}ms`);
      warnOnRetentionBacklog(LOG_PREFIX, 'device_change_log', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('change_log_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return { durationMs, deletedCount, retentionDays, batches, hasMore };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeChangeLogRetention(): Promise<void> {
  try {
    retentionWorker = createChangeLogRetentionWorker();
  attachWorkerObservability(retentionWorker, 'changeLogRetention');

    retentionWorker.on('error', (error) => {
      console.error('[ChangeLogRetention] Worker error:', error);
      captureException(error);
    });

    retentionWorker.on('failed', (job, error) => {
      console.error(`[ChangeLogRetention] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    const queue = getChangeLogRetentionQueue();

    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('change-log-retention') },
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

export const __testOnly = {
  QUEUE_NAME,
  DEFAULT_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
};
