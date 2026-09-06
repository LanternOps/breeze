/**
 * SNMP Metrics Retention Worker
 *
 * BullMQ worker that prunes old SNMP metric entries in bounded ctid batches.
 * Default retention: 7 days (configurable via SNMP_METRICS_RETENTION_DAYS,
 * clamped to 1..365). Batch bounds: SNMP_METRICS_RETENTION_BATCH_SIZE /
 * SNMP_METRICS_RETENTION_MAX_BATCHES.
 *
 * Previously a single unbounded DELETE with a hardcoded 7-day window and no env
 * override, unlike every sibling (#4343). Pruning rides
 * `snmp_metrics_timestamp_idx`.
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[SnmpRetention]';
const QUEUE_NAME = 'snmp-retention';
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.SNMP_METRICS_RETENTION_DAYS, 7, MAX_RETENTION_DAYS, LOG_PREFIX);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'SNMP_METRICS_RETENTION_BATCH_SIZE', 10000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'SNMP_METRICS_RETENTION_MAX_BATCHES', 200);

let retentionQueue: Queue | null = null;

export function getSnmpRetentionQueue(): Queue {
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

export function createSnmpRetentionWorker(): Worker<RetentionJobData> {
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

      const { deleted: deletedCount, batches, hasMore } = await pruneInCtidBatches({
        table: 'snmp_metrics',
        where: sql`"timestamp" < ${cutoff}`,
        batchSize,
        maxBatches,
        label: 'snmpRetention.prune',
      });

      const durationMs = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Pruned ${deletedCount} metrics older than ${retentionDays} days (batches=${batches}) in ${durationMs}ms`);
      warnOnRetentionBacklog(LOG_PREFIX, 'snmp_metrics', { deleted: deletedCount, batches, hasMore });
      // The batched prune now tracks a real rows-deleted count (unlike the old
      // single unbounded DELETE this replaced), so publish it as such.
      recordRetentionRun('snmp_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return { durationMs, deletedCount, retentionDays, batches, hasMore };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeSnmpRetention(): Promise<void> {
  try {
    retentionWorker = createSnmpRetentionWorker();
    attachWorkerObservability(retentionWorker, 'snmpRetention');

    retentionWorker.on('error', (error) => {
      console.error('[SnmpRetention] Worker error:', error);
    });

    const queue = getSnmpRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Every 6h at a registry-allocated slot (jobs/scheduleRegistry.ts).
    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        repeat: { pattern: jobSchedule('snmp-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[SnmpRetention] Retention worker initialized');
  } catch (error) {
    console.error('[SnmpRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownSnmpRetention(): Promise<void> {
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
