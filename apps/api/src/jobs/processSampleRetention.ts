/**
 * Process-Sample Retention Worker
 *
 * BullMQ worker that prunes old device_process_samples in bounded ctid batches.
 * Default retention: 7 days (configurable via PROCESS_SAMPLE_RETENTION_DAYS, max 14).
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[ProcessSampleRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'process-sample-retention';
const BATCH_SIZE = 10000;
const DEFAULT_RETENTION_DAYS = Math.min(14, Math.max(1, parseInt(process.env.PROCESS_SAMPLE_RETENTION_DAYS || '7', 10)));

type RetentionJobData = { retentionDays?: number };

/**
 * postgres-js / drizzle row-count extraction. The result may expose `.count`
 * (postgres-js DELETE), `.rowCount`, or — when the driver returns rows as an
 * array — fall back to `.length`. Mirrors `auditRetention.extractRowCount`
 * (and the inline `.count ?? .length` check in `ipHistoryRetention`) so we never
 * report 0 when rows were actually deleted — which would prematurely end the
 * batched-delete loop and silently leave old rows.
 */
export function extractRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number };
  if (typeof raw.rowCount === 'number') return raw.rowCount;
  if (typeof raw.count === 'number') return raw.count;
  return Array.isArray(result) ? (result as unknown[]).length : 0;
}

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getProcessSampleRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export function createProcessSampleRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const retentionDays = Math.min(14, Math.max(1, job.data.retentionDays ?? DEFAULT_RETENTION_DAYS));
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const startedAt = Date.now();

        let deleted = 0;
        for (;;) {
          const result = await db.execute(sql`
            DELETE FROM device_process_samples
            WHERE ctid IN (
              SELECT ctid FROM device_process_samples
              WHERE "timestamp" < ${cutoff}
              LIMIT ${BATCH_SIZE}
            )
          `);
          const n = extractRowCount(result);
          deleted += n;
          if (n < BATCH_SIZE) break;
        }

        const durationMs = Date.now() - startedAt;
        console.log(`[ProcessSampleRetention] Pruned ${deleted} process samples older than ${retentionDays} days in ${durationMs}ms`);
        return { retentionDays, deleted, durationMs };
      });
    },
    { connection: getBullMQConnection(), concurrency: 1 }
  );
}

export async function initializeProcessSampleRetention(): Promise<void> {
  try {
    retentionWorker = createProcessSampleRetentionWorker();
    retentionWorker.on('error', (error) => {
      console.error('[ProcessSampleRetention] Worker error:', error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`[ProcessSampleRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
      captureException(error);
    });

    const queue = getProcessSampleRetentionQueue();
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      { repeat: { every: 24 * 60 * 60 * 1000 }, removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } }
    );

    console.log('[ProcessSampleRetention] Retention worker initialized');
  } catch (error) {
    console.error('[ProcessSampleRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownProcessSampleRetention(): Promise<void> {
  if (retentionWorker) { await retentionWorker.close(); retentionWorker = null; }
  if (retentionQueue) { await retentionQueue.close(); retentionQueue = null; }
}
