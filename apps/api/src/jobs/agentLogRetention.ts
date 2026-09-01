/**
 * Agent Log Retention Worker
 *
 * BullMQ worker that prunes old agent diagnostic logs in bounded ctid batches.
 * Default retention: 7 days (configurable via AGENT_LOG_RETENTION_DAYS, clamped
 * to 1..365). Batch bounds: AGENT_LOG_RETENTION_BATCH_SIZE /
 * AGENT_LOG_RETENTION_MAX_BATCHES.
 *
 * `agent_logs` is a hot agent-write table, so this used to be the worst kind of
 * sweeper: a single unbounded DELETE holding a pooled connection (and row locks
 * on a table the agent path is inserting into) for the whole statement (#4343).
 * Pruning rides `agent_logs_timestamp_idx`.
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

const LOG_PREFIX = '[AgentLogRetention]';
const QUEUE_NAME = 'agent-log-retention';
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.AGENT_LOG_RETENTION_DAYS, 7, MAX_RETENTION_DAYS, LOG_PREFIX);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'AGENT_LOG_RETENTION_BATCH_SIZE', 10000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'AGENT_LOG_RETENTION_MAX_BATCHES', 200);

let retentionQueue: Queue | null = null;

export function getAgentLogRetentionQueue(): Queue {
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

export function createAgentLogRetentionWorker(): Worker<RetentionJobData> {
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
        table: 'agent_logs',
        where: sql`"timestamp" < ${cutoff}`,
        batchSize,
        maxBatches,
        label: 'agentLogRetention.prune',
      });

      const durationMs = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Pruned ${deletedCount} agent logs older than ${retentionDays} days (batches=${batches}) in ${durationMs}ms`);
      warnOnRetentionBacklog(LOG_PREFIX, 'agent_logs', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('agent_log_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return { durationMs, deletedCount, retentionDays, batches, hasMore };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeAgentLogRetention(): Promise<void> {
  try {
    retentionWorker = createAgentLogRetentionWorker();
    attachWorkerObservability(retentionWorker, 'agentLogRetention');

    retentionWorker.on('error', (error) => {
      console.error('[AgentLogRetention] Worker error:', error);
    });

    const queue = getAgentLogRetentionQueue();

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
        repeat: { pattern: jobSchedule('agent-log-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[AgentLogRetention] Retention worker initialized');
  } catch (error) {
    console.error('[AgentLogRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAgentLogRetention(): Promise<void> {
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
