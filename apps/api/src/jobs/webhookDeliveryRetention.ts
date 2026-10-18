/**
 * webhook_deliveries retention (#9128, deferred from connection-health W4 #9045).
 *
 * One row per (webhook, event) delivery, never removed. A daily, bounded,
 * DELETE-only sweep removes TERMINAL rows (`delivered`, `failed`) whose
 * `created_at` is past the retention window.
 *
 * Deliberately never touches `pending` / `retrying`: those are owned by
 * `webhookDeliveryRecovery`, which re-queues them.
 *
 * The connection-health webhook source (services/connectionHealth/sources/
 * webhook.ts) only looks at failed rows in the last TERMINAL_FAILURE_WINDOW_MS
 * (1 h), so even the shortest configurable window (1 day) leaves it untouched.
 *
 * The failed rows ride `webhook_deliveries_failed_recent_idx`; delivered rows
 * have no supporting index, so each batch is a LIMITed ctid scan. Old rows sit
 * early in the heap and the sweep runs daily, so the LIMIT stops the scan
 * quickly after the first catch-up; an index would need a migration.
 *
 * The table has no org_id (scoped via webhook_id), so this is one global sweep,
 * not a per-org fan-out. Each batch runs in its own system-context transaction
 * (see retentionBatch.ts).
 */

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

const LOG_PREFIX = '[WebhookDeliveryRetention]';
const QUEUE_NAME = 'webhook-delivery-retention';
const TABLE = 'webhook_deliveries';
const DAY_MS = 86_400_000;

const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.WEBHOOK_DELIVERY_RETENTION_DAYS, 90, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'WEBHOOK_DELIVERY_RETENTION_BATCH_SIZE', 1000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'WEBHOOK_DELIVERY_RETENTION_MAX_BATCHES', 100);

export interface RetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface WebhookDeliveryRetentionResult {
  deleted: number;
  batches: number;
  hasMore: boolean;
  retentionDays: number;
  durationMs: number;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getWebhookDeliveryRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runWebhookDeliveryRetention(
  job: RetentionJobData = {},
): Promise<WebhookDeliveryRetentionResult> {
  const startedAt = Date.now();
  const retentionDays = resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS);
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);

  // postgres-js does not coerce a JS Date in a template-literal param; the
  // column is `timestamp` written in UTC, so bind an ISO string.
  const cutoff = new Date(startedAt - retentionDays * DAY_MS).toISOString();

  const pruned = await pruneInCtidBatches({
    table: TABLE,
    where: sql`status IN ('delivered', 'failed') AND created_at < ${cutoff}::timestamp`,
    batchSize,
    maxBatches,
    label: 'webhookDeliveryRetention',
  });

  const durationMs = Date.now() - startedAt;
  console.log(
    `${LOG_PREFIX} Deleted ${pruned.deleted} terminal deliveries older than ${retentionDays} days ` +
    `(batches=${pruned.batches}) in ${durationMs}ms`,
  );
  warnOnRetentionBacklog(LOG_PREFIX, TABLE, {
    deleted: pruned.deleted, batches: pruned.batches, hasMore: pruned.hasMore,
  });
  recordRetentionRun('webhook_delivery_retention', { rowsDeleted: pruned.deleted, incomplete: pruned.hasMore });

  return {
    deleted: pruned.deleted,
    batches: pruned.batches,
    hasMore: pruned.hasMore,
    retentionDays,
    durationMs,
  };
}

export function createWebhookDeliveryRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => runWebhookDeliveryRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeWebhookDeliveryRetention(): Promise<void> {
  try {
    retentionWorker = createWebhookDeliveryRetentionWorker();
    attachWorkerObservability(retentionWorker, 'webhookDeliveryRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getWebhookDeliveryRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('webhook-delivery-retention') },
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

export async function shutdownWebhookDeliveryRetention(): Promise<void> {
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
