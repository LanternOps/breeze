import { Job, Queue, Worker } from 'bullmq';

import {
  DEFAULT_METRIC_ROLLUP_DELETE_BATCH_SIZE,
  DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_AHEAD,
  DEFAULT_METRIC_ROLLUP_PARTITION_MONTHS_BACK,
  runMetricRollupMaintenance,
  type MetricRollupMaintenanceResult,
} from '../services/metricRollupMaintenance';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { cronFromEnv } from './scheduleRegistry';

const QUEUE_NAME = 'metric-rollup-maintenance';
const JOB_NAME = 'metric-rollup-maintenance';
const REPEAT_JOB_ID = 'metric-rollup-maintenance';
const DAILY_CRON = cronFromEnv('METRIC_ROLLUP_MAINTENANCE_CRON', 'metric-rollup-maintenance');

export type MetricRollupMaintenanceJobData = {
  requestedAt?: string;
  partitionMonthsBack?: number;
  partitionMonthsAhead?: number;
  deleteBatchSize?: number;
  /** Ignored. Pre-#7531 repeatable jobs still carry it in their stored data. */
  maxDeleteBatches?: number;
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

      // No outer DB context (#7531): runMetricRollupMaintenance runs every step
      // in its own short system transaction. Wrapping the whole run in one
      // would hold each partition DROP's ACCESS EXCLUSIVE lock on
      // metric_rollups until the end of the run, blocking every reader.
      const result = await runMetricRollupMaintenance({
        now: job.data.requestedAt ? new Date(job.data.requestedAt) : undefined,
        partitionMonthsBack: job.data.partitionMonthsBack,
        partitionMonthsAhead: job.data.partitionMonthsAhead,
        deleteBatchSize: job.data.deleteBatchSize,
      });
      console.log(
        `[MetricRollupMaintenance] ensured=${result.ensuredPartitions.length} droppedMonths=${result.droppedPartitions.length}` +
          ` droppedBucketLeaves=${result.droppedBucketPartitions.length} compacted=${result.compactedPartitions.length}` +
          ` defaultRowsDeleted=${result.defaultPartitionRowsDeleted} defaultRowsMoved=${result.defaultPartitionDrain.rowsMoved}` +
          ` defaultBlockedMonths=${result.defaultPartitionDrain.blockedMonths.length}` +
          ` failures=${result.failures.length} durationMs=${result.durationMs}`,
      );
      if (result.skipped) {
        console.warn(`[MetricRollupMaintenance] Run skipped: ${result.reason ?? 'unknown reason'}`);
      }
      // A lock-contended run returns `skipped` with empty arrays — recording it
      // would claim "ran, backlog clear" for work that never happened.
      if (!result.skipped) {
        recordRetentionRun('metric_rollup_maintenance', {
          rowsDeleted: result.defaultPartitionRowsDeleted,
          incomplete: result.failures.length > 0,
        });
      }
      if (result.failures.length > 0) {
        // Every other step still ran; fail the job so the stuck step is seen
        // (a month that never compacts or drops is disk that never comes back).
        throw new Error(
          `[MetricRollupMaintenance] ${result.failures.length} step(s) failed: ` +
            result.failures.map((f) => `${f.step} ${f.partition}: ${f.error}`).join('; '),
        );
      }
      return result;
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
