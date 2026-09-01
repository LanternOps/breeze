/**
 * Ticket Outbox Retention Worker
 *
 * BullMQ worker that prunes `ticket_outbox` rows once they have reached a
 * terminal state, in bounded ctid batches (#4210, follow-up to #3828 /
 * PRs #4195 #4203). Before this job, `ticket_outbox` accumulated every
 * lifecycle event forever — `ticketOutboxPublisher.ts` drains rows within
 * seconds, but nothing ever deleted the drained rows, so the table (and its
 * indexes) grew without bound and org erasure had to walk an ever-larger
 * table for no operational benefit.
 *
 * A row is terminal — and therefore eligible for pruning — in exactly two
 * cases, mirroring `ticketOutboxPublisher.ts`'s own claim query:
 *
 *  - DELIVERED: `published_at IS NOT NULL`. Cutoff is measured from
 *    `published_at` — the row has done its job.
 *  - PERMANENTLY FAILED: still unpublished but `publish_attempts` has
 *    exceeded `ticketOutboxPublisher.MAX_PUBLISH_ATTEMPTS` — the publisher
 *    itself has given up retrying these (see that file's stuck-row alarm)
 *    and will never touch them again. Cutoff is measured from `created_at`
 *    since there is no `published_at` to measure from.
 *
 * A row that is neither (unpublished, attempts still within budget) is never
 * touched, regardless of age — it may still be delivered on the next
 * publisher pass.
 *
 * Default retention: 14 days (configurable via TICKET_OUTBOX_RETENTION_DAYS,
 * clamped to 1..365). Batch bounds: TICKET_OUTBOX_RETENTION_BATCH_SIZE /
 * TICKET_OUTBOX_RETENTION_MAX_BATCHES.
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { ticketOutbox } from '../db/schema/ticketOutbox';
import { MAX_PUBLISH_ATTEMPTS } from './ticketOutboxPublisher';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[TicketOutboxRetention]';
const QUEUE_NAME = 'ticket-outbox-retention';
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.TICKET_OUTBOX_RETENTION_DAYS, 14, MAX_RETENTION_DAYS, LOG_PREFIX);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'TICKET_OUTBOX_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'TICKET_OUTBOX_RETENTION_MAX_BATCHES', 50);

let retentionQueue: Queue | null = null;

export function getTicketOutboxRetentionQueue(): Queue {
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

export function createTicketOutboxRetentionWorker(): Worker<RetentionJobData> {
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
        table: 'ticket_outbox',
        where: sql`(
          ${ticketOutbox.publishedAt} IS NOT NULL AND ${ticketOutbox.publishedAt} < ${cutoff}::timestamptz
        ) OR (
          ${ticketOutbox.publishedAt} IS NULL
          AND ${ticketOutbox.publishAttempts} > ${MAX_PUBLISH_ATTEMPTS}
          AND ${ticketOutbox.createdAt} < ${cutoff}::timestamptz
        )`,
        batchSize,
        maxBatches,
        label: 'ticketOutboxRetention.prune',
      });

      const durationMs = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Pruned ${deletedCount} ticket_outbox rows older than ${retentionDays} days (batches=${batches}) in ${durationMs}ms`);
      warnOnRetentionBacklog(LOG_PREFIX, 'ticket_outbox', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('ticket_outbox_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return { durationMs, deletedCount, retentionDays, batches, hasMore };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeTicketOutboxRetention(): Promise<void> {
  try {
    retentionWorker = createTicketOutboxRetentionWorker();
    attachWorkerObservability(retentionWorker, 'ticketOutboxRetention');

    retentionWorker.on('error', (error) => {
      console.error('[TicketOutboxRetention] Worker error:', error);
    });

    const queue = getTicketOutboxRetentionQueue();

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
        repeat: { pattern: jobSchedule('ticket-outbox-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[TicketOutboxRetention] Retention worker initialized');
  } catch (error) {
    console.error('[TicketOutboxRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownTicketOutboxRetention(): Promise<void> {
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
