/**
 * Intent Outbox Retention Worker
 *
 * BullMQ worker that prunes `intent_outbox` rows once they have reached a
 * terminal state, in bounded ctid batches (#4210, follow-up to #3828 /
 * PRs #4195 #4203). Before this job, `intent_outbox` accumulated every
 * action-intent lifecycle event forever — `intentOutboxPublisher.ts` drains
 * rows within seconds, but nothing ever deleted the drained rows, so the
 * table (and its indexes) grew without bound for no operational benefit.
 * (`intent_outbox` is INTENTIONALLY UNSCOPED / system-only — see
 * `db/schema/actionIntents.ts`'s doc comment — but it is still an
 * unconditional accumulator that needs a floor.)
 *
 * A row is terminal — and therefore eligible for pruning — in exactly two
 * cases, mirroring `intentOutboxPublisher.ts`'s own claim query:
 *
 *  - DELIVERED: `published_at IS NOT NULL`. Cutoff is measured from
 *    `published_at` — the row has done its job.
 *  - PERMANENTLY FAILED: still unpublished but `publish_attempts` has
 *    exceeded `intentOutboxPublisher.MAX_PUBLISH_ATTEMPTS` — the publisher
 *    itself has given up retrying these (see that file's stuck-row alarm)
 *    and will never touch them again. Cutoff is measured from `created_at`
 *    since there is no `published_at` to measure from.
 *
 * A row that is neither (unpublished, attempts still within budget) is never
 * touched, regardless of age — it may still be delivered on the next
 * publisher pass.
 *
 * Default retention: 14 days (configurable via INTENT_OUTBOX_RETENTION_DAYS,
 * clamped to 1..365). Batch bounds: INTENT_OUTBOX_RETENTION_BATCH_SIZE /
 * INTENT_OUTBOX_RETENTION_MAX_BATCHES.
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { intentOutbox } from '../db/schema/actionIntents';
import { MAX_PUBLISH_ATTEMPTS } from './intentOutboxPublisher';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[IntentOutboxRetention]';
const QUEUE_NAME = 'intent-outbox-retention';
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.INTENT_OUTBOX_RETENTION_DAYS, 14, MAX_RETENTION_DAYS, LOG_PREFIX);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'INTENT_OUTBOX_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'INTENT_OUTBOX_RETENTION_MAX_BATCHES', 50);

let retentionQueue: Queue | null = null;

export function getIntentOutboxRetentionQueue(): Queue {
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

export function createIntentOutboxRetentionWorker(): Worker<RetentionJobData> {
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
        table: 'intent_outbox',
        where: sql`(
          ${intentOutbox.publishedAt} IS NOT NULL AND ${intentOutbox.publishedAt} < ${cutoff}::timestamptz
        ) OR (
          ${intentOutbox.publishedAt} IS NULL
          AND ${intentOutbox.publishAttempts} > ${MAX_PUBLISH_ATTEMPTS}
          AND ${intentOutbox.createdAt} < ${cutoff}::timestamptz
        )`,
        batchSize,
        maxBatches,
        label: 'intentOutboxRetention.prune',
      });

      const durationMs = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Pruned ${deletedCount} intent_outbox rows older than ${retentionDays} days (batches=${batches}) in ${durationMs}ms`);
      warnOnRetentionBacklog(LOG_PREFIX, 'intent_outbox', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('intent_outbox_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return { durationMs, deletedCount, retentionDays, batches, hasMore };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeIntentOutboxRetention(): Promise<void> {
  try {
    retentionWorker = createIntentOutboxRetentionWorker();
    attachWorkerObservability(retentionWorker, 'intentOutboxRetention');

    retentionWorker.on('error', (error) => {
      console.error('[IntentOutboxRetention] Worker error:', error);
    });

    const queue = getIntentOutboxRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Daily at a registry-allocated slot (jobs/scheduleRegistry.ts).
    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('intent-outbox-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[IntentOutboxRetention] Retention worker initialized');
  } catch (error) {
    console.error('[IntentOutboxRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownIntentOutboxRetention(): Promise<void> {
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
