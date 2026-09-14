/**
 * Monitor Episode Retention Worker
 *
 * BullMQ worker that prunes CLOSED `monitor_episodes` rows in bounded ctid
 * batches (#5290, W03). Retention is fixed at 400 days — unlike the sibling
 * `*_RETENTION_DAYS` knobs, this is NOT wired through
 * `retentionBatch.resolveRetentionDays`: every other job in this family caps
 * at `MAX_RETENTION_DAYS = 365`, and running 400 through that same cap would
 * silently shorten this table's 400-day contract on day one. Batch
 * size/count remain tunable via `MONITOR_EPISODE_RETENTION_BATCH_SIZE` /
 * `MONITOR_EPISODE_RETENTION_MAX_BATCHES` — those only pace the sweep, they
 * don't change what gets deleted.
 *
 * An OPEN episode (`ended_at IS NULL`) is NEVER pruned however old it is — a
 * device stuck in breach for over a year is a real open incident, not
 * garbage. The delete predicate requires `ended_at IS NOT NULL` in addition
 * to the age cutoff so an open episode can never match.
 *
 * Pruning rides `monitor_episodes_window_idx` / `monitor_episodes_device_idx`;
 * a dedicated `ended_at` index is not required at this table's expected size,
 * but if the sweep starts Seq-Scanning, add one the same way
 * `2026-07-29-timeseries-retention-brin` did for
 * `service_process_check_results`.
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

const LOG_PREFIX = '[MonitorEpisodeRetention]';
const QUEUE_NAME = 'monitor-episode-retention';

/**
 * Fixed at 400 days. See the module header for why this is a plain constant
 * rather than an env-configurable, `resolveRetentionDays`-clamped knob.
 */
export const MONITOR_EPISODE_RETENTION_DAYS = 400;

const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'MONITOR_EPISODE_RETENTION_BATCH_SIZE', 10000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'MONITOR_EPISODE_RETENTION_MAX_BATCHES', 200);

let retentionQueue: Queue | null = null;

export function getMonitorEpisodeRetentionQueue(): Queue {
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

/**
 * `ended_at IS NOT NULL` comes first so an open episode can never match this
 * predicate regardless of how old `started_at` is.
 */
async function pruneClosedMonitorEpisodes(input: {
  cutoff: string;
  batchSize: number;
  maxBatches: number;
}) {
  return pruneInCtidBatches({
    table: 'monitor_episodes',
    where: sql`ended_at IS NOT NULL AND ended_at < ${input.cutoff}`,
    batchSize: input.batchSize,
    maxBatches: input.maxBatches,
    label: 'monitorEpisodeRetention.prune',
  });
}

export function createMonitorEpisodeRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper here: pruneInCtidBatches opens one per batch, so that
    // each batch commits and releases its locks (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => {
      const startTime = Date.now();
      const batchSize = Math.max(1, job.data.batchSize ?? BATCH_SIZE);
      const maxBatches = Math.max(1, job.data.maxBatches ?? MAX_BATCHES);
      // postgres-js does not coerce JS Date in template-literal params; pass an ISO string.
      const cutoff = new Date(
        Date.now() - MONITOR_EPISODE_RETENTION_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

      const { deleted: deletedCount, batches, hasMore } = await pruneClosedMonitorEpisodes({
        cutoff,
        batchSize,
        maxBatches,
      });

      const durationMs = Date.now() - startTime;
      console.log(
        `${LOG_PREFIX} Pruned ${deletedCount} closed monitor episodes older than ${MONITOR_EPISODE_RETENTION_DAYS} days (batches=${batches}) in ${durationMs}ms`
      );
      warnOnRetentionBacklog(LOG_PREFIX, 'monitor_episodes', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('monitor_episode_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return {
        durationMs,
        deletedCount,
        retentionDays: MONITOR_EPISODE_RETENTION_DAYS,
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

export async function initializeMonitorEpisodeRetention(): Promise<void> {
  try {
    retentionWorker = createMonitorEpisodeRetentionWorker();
    attachWorkerObservability(retentionWorker, 'monitorEpisodeRetention');

    retentionWorker.on('error', (error) => {
      console.error('[MonitorEpisodeRetention] Worker error:', error);
    });

    const queue = getMonitorEpisodeRetentionQueue();

    // Remove existing repeatable jobs
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
      {
        // Daily at a registry-allocated slot. NOT `every: 24h` — BullMQ anchors
        // `every` to the Unix epoch, so every 24h job fires at 00:00:00.000 UTC
        // together (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('monitor-episode-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[MonitorEpisodeRetention] Retention worker initialized');
  } catch (error) {
    console.error('[MonitorEpisodeRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMonitorEpisodeRetention(): Promise<void> {
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
  MONITOR_EPISODE_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
  pruneClosedMonitorEpisodes,
};
