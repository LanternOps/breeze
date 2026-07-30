/**
 * Device-Metrics Retention Worker
 *
 * BullMQ worker that prunes old device_metrics in bounded ctid batches.
 * Default retention: 30 days (configurable via DEVICE_METRICS_RETENTION_DAYS,
 * clamped to 1..365).
 *
 * `device_metrics` is the raw 1-row-per-device-per-heartbeat series. The
 * history views are served from `metric_rollups`, whose partitions already have
 * their own retention (`METRIC_ROLLUP_*_RETENTION_DAYS`) — that retention has
 * never covered this source table, which is why it grew unbounded (#2827).
 *
 * Pruning relies on `device_metrics_timestamp_brin_idx`
 * (migration 2026-07-29-timeseries-retention-brin); without it the predicate
 * plans a Seq Scan per batch.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[DeviceMetricsRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'device-metrics-retention';
const BATCH_SIZE = 10000;
const MAX_RETENTION_DAYS = 365;

export function clampRetentionDays(value: number): number {
  return Math.min(MAX_RETENTION_DAYS, Math.max(1, value));
}

/**
 * Resolve the configured retention window, falling back on anything that isn't
 * a usable positive number.
 *
 * Anything that is not a finite positive number falls back to the default
 * INSTEAD of being clamped, which matters in two ways:
 *
 *  - `parseInt('nonsense', 10)` is NaN, and NaN survives `Math.min`/`Math.max`
 *    unchanged — a clamp alone would carry it into the cutoff, where
 *    `new Date(NaN).toISOString()` throws RangeError and the worker dies on
 *    every run.
 *  - `0` and negatives read as "no retention"/misconfiguration. Clamping those
 *    to the 1-day floor would silently prune almost the entire table on the
 *    next run, so they must fall back rather than clamp.
 */
export function resolveRetentionDays(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw || '', 10);
  return clampRetentionDays(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback);
}

const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.DEVICE_METRICS_RETENTION_DAYS, 30);

type RetentionJobData = { retentionDays?: number };

/**
 * postgres-js / drizzle row-count extraction. Mirrors
 * `processSampleRetention.extractRowCount` — never report 0 when rows were
 * actually deleted, which would prematurely end the batched-delete loop and
 * silently leave old rows behind.
 */
export function extractRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? (result as unknown[]).length : 0;
}

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getDeviceMetricsRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export function createDeviceMetricsRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const retentionDays = clampRetentionDays(job.data.retentionDays ?? DEFAULT_RETENTION_DAYS);
        // postgres-js does not coerce JS Date in template-literal params; pass an ISO string.
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const startedAt = Date.now();

        let deleted = 0;
        for (;;) {
          const result = await db.execute(sql`
            DELETE FROM device_metrics
            WHERE ctid IN (
              SELECT ctid FROM device_metrics
              WHERE "timestamp" < ${cutoff}
              LIMIT ${BATCH_SIZE}
            )
          `);
          const n = extractRowCount(result);
          deleted += n;
          if (n < BATCH_SIZE) break;
        }

        const durationMs = Date.now() - startedAt;
        console.log(`[DeviceMetricsRetention] Pruned ${deleted} device metrics older than ${retentionDays} days in ${durationMs}ms`);
        return { retentionDays, deleted, durationMs };
      });
    },
    { connection: getBullMQConnection(), concurrency: 1 }
  );
}

export async function initializeDeviceMetricsRetention(): Promise<void> {
  try {
    retentionWorker = createDeviceMetricsRetentionWorker();
    retentionWorker.on('error', (error) => {
      console.error('[DeviceMetricsRetention] Worker error:', error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`[DeviceMetricsRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
      captureException(error);
    });

    const queue = getDeviceMetricsRetentionQueue();
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      { repeat: { every: 24 * 60 * 60 * 1000 }, removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } }
    );

    console.log('[DeviceMetricsRetention] Retention worker initialized');
  } catch (error) {
    console.error('[DeviceMetricsRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownDeviceMetricsRetention(): Promise<void> {
  if (retentionWorker) { await retentionWorker.close(); retentionWorker = null; }
  if (retentionQueue) { await retentionQueue.close(); retentionQueue = null; }
}
