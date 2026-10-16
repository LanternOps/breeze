/**
 * EDR Detection Retention Worker
 *
 * BullMQ worker that prunes TERMINAL `edr_detections` rows in bounded ctid
 * batches (#8164, W02). Retention is fixed at 180 days (owner-approved), a
 * plain constant rather than an env knob so the contract cannot drift per
 * deployment. Batch size/count remain tunable via
 * `EDR_DETECTION_RETENTION_BATCH_SIZE` / `EDR_DETECTION_RETENTION_MAX_BATCHES`
 * — those only pace the sweep, they don't change what gets deleted.
 *
 * WHAT IS DELETED
 *   status IN ('resolved','dismissed','false_positive','mitigated')
 *   AND COALESCE(resolved_at, last_vendor_update_at, updated_at) < now() - 180d
 *
 * `open`, `in_progress` and `unknown` rows are NEVER pruned however old they
 * are: a vendor detection that is still live (or that we could not classify)
 * is an open incident, not garbage. The delete predicate is an allow-list of
 * the four terminal statuses, so a status added later is kept by default.
 *
 * Tombstones (`detached_at IS NOT NULL`) follow the same status/age rule —
 * there is deliberately no detached_at term.
 *
 * `edr_actions` is NOT touched here (its `detection_id` has no FK that would
 * require it, and the action ledger has its own audit lifecycle).
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
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[EdrDetectionRetention]';
const QUEUE_NAME = 'edr-detection-retention';

/** Fixed at 180 days. See the module header. */
export const EDR_DETECTION_RETENTION_DAYS = 180;

/**
 * Terminal statuses eligible for pruning. An allow-list on purpose: `open`,
 * `in_progress` and `unknown` (the feed's "still open" set) must never match.
 */
const PRUNABLE_STATUSES = ['resolved', 'dismissed', 'false_positive', 'mitigated'] as const;

const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'EDR_DETECTION_RETENTION_BATCH_SIZE', 10000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'EDR_DETECTION_RETENTION_MAX_BATCHES', 200);

let retentionQueue: Queue | null = null;

export function getEdrDetectionRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection()
    });
  }
  return retentionQueue;
}

interface RetentionJobData {
  batchSize?: number;
  maxBatches?: number;
}

/** postgres-js does not coerce JS Date in template-literal params; pass an ISO string. */
function cutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - EDR_DETECTION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function pruneTerminalEdrDetections(input: {
  cutoff: string;
  batchSize: number;
  maxBatches: number;
}) {
  const statuses = sql.join(PRUNABLE_STATUSES.map((s) => sql`${s}`), sql`, `);
  return pruneInCtidBatches({
    table: 'edr_detections',
    where: sql`status IN (${statuses}) AND COALESCE(resolved_at, last_vendor_update_at, updated_at) < ${input.cutoff}::timestamptz`,
    batchSize: input.batchSize,
    maxBatches: input.maxBatches,
    label: 'edrDetectionRetention.prune',
  });
}

export function createEdrDetectionRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper here: pruneInCtidBatches opens one per batch, so that
    // each batch commits and releases its locks (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => {
      const startTime = Date.now();
      const batchSize = Math.max(1, job.data.batchSize ?? BATCH_SIZE);
      const maxBatches = Math.max(1, job.data.maxBatches ?? MAX_BATCHES);

      const { deleted: deletedCount, batches, hasMore } = await pruneTerminalEdrDetections({
        cutoff: cutoffIso(),
        batchSize,
        maxBatches,
      });

      const durationMs = Date.now() - startTime;
      console.log(
        `${LOG_PREFIX} Pruned ${deletedCount} terminal EDR detections older than ${EDR_DETECTION_RETENTION_DAYS} days (batches=${batches}) in ${durationMs}ms`
      );
      warnOnRetentionBacklog(LOG_PREFIX, 'edr_detections', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('edr_detection_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return {
        durationMs,
        deletedCount,
        retentionDays: EDR_DETECTION_RETENTION_DAYS,
        batches,
        hasMore,
      };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeEdrDetectionRetention(): Promise<void> {
  try {
    retentionWorker = createEdrDetectionRetentionWorker();
    attachWorkerObservability(retentionWorker, 'edrDetectionRetentionWorker');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
    });

    const queue = getEdrDetectionRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — see
        // jobs/scheduleRegistry.ts.
        repeat: { pattern: jobSchedule('edr-detection-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownEdrDetectionRetention(): Promise<void> {
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
  EDR_DETECTION_RETENTION_DAYS,
  PRUNABLE_STATUSES,
  BATCH_SIZE,
  MAX_BATCHES,
  cutoffIso,
  pruneTerminalEdrDetections,
};
