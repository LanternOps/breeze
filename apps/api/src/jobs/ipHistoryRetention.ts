/**
 * IP History Retention Worker
 *
 * BullMQ worker that prunes inactive IP history rows in bounded ctid batches
 * after a retention period. Default retention: 90 days (configurable via
 * IP_HISTORY_RETENTION_DAYS, clamped to 1..365). Batch bounds:
 * IP_HISTORY_RETENTION_BATCH_SIZE / IP_HISTORY_RETENTION_MAX_BATCHES.
 *
 * Previously a single unbounded DELETE that held a pooled connection for the
 * whole statement (#4343).
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[IPHistoryRetention]';
const QUEUE_NAME = 'ip-history-retention';
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.IP_HISTORY_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'IP_HISTORY_RETENTION_BATCH_SIZE', 10000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'IP_HISTORY_RETENTION_MAX_BATCHES', 200);

let retentionQueue: Queue | null = null;

export function getIPHistoryRetentionQueue(): Queue {
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

export function createIPHistoryRetentionWorker(): Worker<RetentionJobData> {
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

      // Only INACTIVE rows are eligible, and the bound stays `<=` as before —
      // an active row has no deactivated_at and must never be pruned.
      const { deleted: deletedCount, batches, hasMore } = await pruneInCtidBatches({
        table: 'device_ip_history',
        where: sql`is_active = false AND deactivated_at <= ${cutoff}`,
        batchSize,
        maxBatches,
        label: 'ipHistoryRetention.prune',
      });

      const durationMs = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Pruned ${deletedCount} inactive rows older than ${retentionDays} days (batches=${batches}) in ${durationMs}ms`);
      warnOnRetentionBacklog(LOG_PREFIX, 'device_ip_history', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('ip_history_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return { durationMs, deletedCount, retentionDays, batches, hasMore };
    },
    {
      connection: getBullMQConnection(),
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
      { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('ip-history-retention') },
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

export const __testOnly = {
  QUEUE_NAME,
  DEFAULT_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
};
