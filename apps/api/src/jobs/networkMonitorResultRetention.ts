/**
 * network_monitor_results retention (#4342 W1). REPORT-ONLY until
 * NETWORK_MONITOR_RESULT_RETENTION_ENFORCE=true (see retentionTarget.ts).
 *
 * One row per network monitor check (ping / port / HTTP / DNS), never
 * removed. A daily sweep deletes results older than the window that have a
 * NEWER result for the same monitor. A paused or disabled monitor keeps its
 * last result whatever its age, so its "last checked" status survives.
 *
 * `network_monitor_results_monitor_ts_idx (monitor_id, "timestamp" DESC)`
 * (W1 migration) serves the newer-row probe. No inbound FKs; rows cascade
 * with their monitor. Each batch runs in its own system transaction
 * (retentionBatch.ts); do not wrap this job in a DB context.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';

import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  parsePositiveIntEnv,
  resolveRetentionDays,
  retentionEnforceFromEnv,
  utcWallTime,
} from './retentionBatch';
import { runRetentionTarget, type RetentionTarget, type RetentionTargetResult } from './retentionTarget';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[NetworkMonitorResultRetention]';
const QUEUE_NAME = 'network-monitor-result-retention';
const TABLE = 'network_monitor_results';
const ENFORCE_VAR = 'NETWORK_MONITOR_RESULT_RETENTION_ENFORCE';

const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(
  process.env.NETWORK_MONITOR_RESULT_RETENTION_DAYS, 30, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'NETWORK_MONITOR_RESULT_RETENTION_BATCH_SIZE', 1000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'NETWORK_MONITOR_RESULT_RETENTION_MAX_BATCHES', 100);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'NETWORK_MONITOR_RESULT_RETENTION_ENFORCE', false);

export const NETWORK_MONITOR_RESULT_RETENTION_TARGET: RetentionTarget = {
  metricName: 'network_monitor_result_retention',
  table: TABLE,
  action: { kind: 'delete' },
  // The bare outer name is required (retentionBatch selects FROM it unaliased).
  where: (cutoffIso) => sql`"timestamp" < ${utcWallTime(cutoffIso)}
    AND EXISTS (
      SELECT 1 FROM network_monitor_results n
      WHERE n.monitor_id = network_monitor_results.monitor_id
        AND n."timestamp" > network_monitor_results."timestamp"
    )`,
};

export interface NetworkMonitorResultRetentionJobData {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<NetworkMonitorResultRetentionJobData> | null = null;

export function getNetworkMonitorResultRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runNetworkMonitorResultRetention(
  job: NetworkMonitorResultRetentionJobData = {},
): Promise<RetentionTargetResult> {
  return runRetentionTarget(
    NETWORK_MONITOR_RESULT_RETENTION_TARGET,
    {
      retentionDays: resolveRetentionDays(job.retentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS),
      batchSize: Math.max(1, job.batchSize ?? BATCH_SIZE),
      maxBatches: Math.max(1, job.maxBatches ?? MAX_BATCHES),
      enforce: ENFORCE && !job.forceReport,
    },
    { logPrefix: LOG_PREFIX, label: 'networkMonitorResultRetention', enforceVar: ENFORCE_VAR },
  );
}

export function createNetworkMonitorResultRetentionWorker(): Worker<NetworkMonitorResultRetentionJobData> {
  return new Worker<NetworkMonitorResultRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<NetworkMonitorResultRetentionJobData>) => runNetworkMonitorResultRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeNetworkMonitorResultRetention(): Promise<void> {
  try {
    retentionWorker = createNetworkMonitorResultRetentionWorker();
    attachWorkerObservability(retentionWorker, 'networkMonitorResultRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getNetworkMonitorResultRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('network-monitor-result-retention') },
      {
        name: 'sweep',
        data: { retentionDays: DEFAULT_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized (${ENFORCE ? 'ENFORCING' : 'report-only'})`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownNetworkMonitorResultRetention(): Promise<void> {
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
  ENFORCE,
};
