import { Job, Queue, Worker } from 'bullmq';

import * as dbModule from '../db';
import {
  DEFAULT_METRIC_ROLLUP_DELETE_BATCH_SIZE,
  DEFAULT_METRIC_ROLLUP_MAX_DELETE_BATCHES,
  DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_AHEAD,
  DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_BACK,
  runMetricRollupMaintenance,
  type MetricRollupMaintenanceResult,
} from '../services/metricRollupMaintenance';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'metric-rollup-maintenance';
const JOB_NAME = 'metric-rollup-maintenance';
const REPEAT_JOB_ID = 'metric-rollup-maintenance';
const DAILY_CRON = process.env.METRIC_ROLLUP_MAINTENANCE_CRON || '15 3 * * *';

export type MetricRollupMaintenanceJobData = {
  requestedAt?: string;
  partitionMonthsBack?: number;
  partitionMonthsAhead?: number;
  deleteBatchSize?: number;
  maxDeleteBatches?: number;
};

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[MetricRollupMaintenance] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

function isMaintenanceEnabled(): boolean {
  const raw = process.env.METRIC_ROLLUP_MAINTENANCE_ENABLED;
  if (raw === undefined || raw === '') return true;
  const value = raw.trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
}

let maintenanceQueue: Queue<MetricRollupMaintenanceJobData> | null = null;
let maintenanceWorker: Worker<MetricRollupMaintenanceJobData> | null = null;

export function getMetricRollupMaintenanceQueue(): Queue<MetricRollupMaintenanceJobData> {
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue<MetricRollupMaintenanceJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return maintenanceQueue;
}

export function createMetricRollupMaintenanceWorker(): Worker<MetricRollupMaintenanceJobData> {
  return new Worker<MetricRollupMaintenanceJobData>(
    QUEUE_NAME,
    async (job: Job<MetricRollupMaintenanceJobData>): Promise<MetricRollupMaintenanceResult | { skipped: true }> => {
      if (job.name !== JOB_NAME) {
        console.warn(`[MetricRollupMaintenance] Ignoring unknown job name: ${job.name}`);
        return { skipped: true };
      }

      return runWithSystemDbAccess(async () => {
        const result = await runMetricRollupMaintenance({
          now: job.data.requestedAt ? new Date(job.data.requestedAt) : undefined,
          partitionMonthsBack: job.data.partitionMonthsBack,
          partitionMonthsAhead: job.data.partitionMonthsAhead,
          deleteBatchSize: job.data.deleteBatchSize,
          maxDeleteBatches: job.data.maxDeleteBatches,
        });
        const deleted = result.retention.reduce((sum, tier) => sum + tier.deleted, 0);
        console.log(
          `[MetricRollupMaintenance] ensured=${result.ensuredPartitions.length} dropped=${result.droppedPartitions.length} deleted=${deleted} durationMs=${result.durationMs}`,
        );
        return result;
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

export async function scheduleMetricRollupMaintenance(
  queue: Queue<MetricRollupMaintenanceJobData> = getMetricRollupMaintenanceQueue(),
): Promise<void> {
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isMaintenanceEnabled()) {
    console.log('[MetricRollupMaintenance] METRIC_ROLLUP_MAINTENANCE_ENABLED=false — skipping schedule registration');
    return;
  }

  await queue.add(
    JOB_NAME,
    {
      partitionMonthsBack: DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_BACK,
      partitionMonthsAhead: DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_AHEAD,
      deleteBatchSize: DEFAULT_METRIC_ROLLUP_DELETE_BATCH_SIZE,
      maxDeleteBatches: DEFAULT_METRIC_ROLLUP_MAX_DELETE_BATCHES,
    },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(`[MetricRollupMaintenance] Scheduled daily maintenance (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`);
}

export async function initializeMetricRollupMaintenanceWorker(): Promise<void> {
  maintenanceWorker = createMetricRollupMaintenanceWorker();
  attachWorkerObservability(maintenanceWorker, 'metricRollupMaintenance');
  await scheduleMetricRollupMaintenance();
  console.log('[MetricRollupMaintenance] Worker initialized');
}

export async function shutdownMetricRollupMaintenanceWorker(): Promise<void> {
  if (maintenanceWorker) {
    await maintenanceWorker.close();
    maintenanceWorker = null;
  }
  if (maintenanceQueue) {
    await maintenanceQueue.close();
    maintenanceQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  isMaintenanceEnabled,
};
