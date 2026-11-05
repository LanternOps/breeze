import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[WakeAttemptRetention]';
const QUEUE_NAME = 'wake-attempt-retention';
const TABLE = 'device_wake_attempts';
const DAY_MS = 86_400_000;

const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.WAKE_ATTEMPT_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'WAKE_ATTEMPT_RETENTION_BATCH_SIZE', 1000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'WAKE_ATTEMPT_RETENTION_MAX_BATCHES', 100);

export interface RetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface WakeAttemptRetentionResult {
  deleted: number;
  batches: number;
  hasMore: boolean;
  retentionDays: number;
  durationMs: number;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getWakeAttemptRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runWakeAttemptRetention(
  job: RetentionJobData = {},
): Promise<WakeAttemptRetentionResult> {
  const startedAt = Date.now();
  const retentionDays = resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS);
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);

  // postgres-js does not coerce a JS Date in a template-literal param; the
  // column is `timestamptz`, so bind an ISO string with an explicit cast.
  const cutoff = new Date(startedAt - retentionDays * DAY_MS).toISOString();

  const pruned = await pruneInCtidBatches({
    table: TABLE,
    where: sql`outcome NOT IN ('pending', 'sent') AND requested_at < ${cutoff}::timestamptz`,
    batchSize,
    maxBatches,
    label: 'wakeAttemptRetention',
  });

  const durationMs = Date.now() - startedAt;
  console.log(
    `${LOG_PREFIX} Deleted ${pruned.deleted} closed attempts older than ${retentionDays} days ` +
    `(batches=${pruned.batches}) in ${durationMs}ms`,
  );
  warnOnRetentionBacklog(LOG_PREFIX, TABLE, {
    deleted: pruned.deleted, batches: pruned.batches, hasMore: pruned.hasMore,
  });
  recordRetentionRun('wake_attempt_retention', { rowsDeleted: pruned.deleted, incomplete: pruned.hasMore });

  return {
    deleted: pruned.deleted,
    batches: pruned.batches,
    hasMore: pruned.hasMore,
    retentionDays,
    durationMs,
  };
}

export function createWakeAttemptRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => runWakeAttemptRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeWakeAttemptRetention(): Promise<void> {
  try {
    retentionWorker = createWakeAttemptRetentionWorker();
    attachWorkerObservability(retentionWorker, 'wakeAttemptRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getWakeAttemptRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('wake-attempt-retention') },
      {
        name: 'sweep',
        data: { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownWakeAttemptRetention(): Promise<void> {
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
  MAX_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
};
