/**
 * Metric Anomaly Incident Retention Worker
 *
 * BullMQ worker that prunes `metric_anomaly_incidents` rows once they have
 * reached a terminal dispatch state, in bounded ctid batches (#4210,
 * follow-up to #3828 / PRs #4195 #4203). Before this job,
 * `metric_anomaly_incidents` accumulated every collapsed anomaly incident
 * forever — `metricAnomalyIncidentPublisher.ts` drains rows within seconds,
 * but nothing ever deleted the drained rows, so the table (and its indexes)
 * grew without bound and org erasure had to walk an ever-larger table for no
 * operational benefit.
 *
 * A row is terminal — and therefore eligible for pruning — in exactly two
 * cases, mirroring `metricAnomalyIncidentPublisher.ts`'s own claim query:
 *
 *  - DISPATCHED: `dispatched_at IS NOT NULL`. Cutoff is measured from
 *    `dispatched_at` — the row has done its job.
 *  - PERMANENTLY FAILED: still undispatched but `dispatch_attempts` has
 *    exceeded `metricAnomalyIncidentPublisher.MAX_PUBLISH_ATTEMPTS` — the
 *    publisher itself has given up retrying these (see that file's
 *    stuck-row alarm) and will never touch them again. Cutoff is measured
 *    from `created_at` since there is no `dispatched_at` to measure from.
 *
 * A row that is neither (undispatched, attempts still within budget) is
 * never touched, regardless of age — it may still be dispatched on the next
 * publisher pass. `lastSeenAt` is deliberately NOT the cutoff column: the
 * detector's re-upsert refreshes `lastSeenAt` on every conflict without
 * touching `dispatchedAt` (see the schema's doc comment), so an incident
 * that keeps recurring would never age out on `lastSeenAt` even after it has
 * long since been dispatched and read.
 *
 * Default retention: 14 days (configurable via
 * METRIC_ANOMALY_INCIDENT_RETENTION_DAYS, clamped to 1..365). Batch bounds:
 * METRIC_ANOMALY_INCIDENT_RETENTION_BATCH_SIZE /
 * METRIC_ANOMALY_INCIDENT_RETENTION_MAX_BATCHES.
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { metricAnomalyIncidents } from '../db/schema/metricAnomalyIncidents';
import { MAX_PUBLISH_ATTEMPTS } from './metricAnomalyIncidentPublisher';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[MetricAnomalyIncidentRetention]';
const QUEUE_NAME = 'metric-anomaly-incident-retention';
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.METRIC_ANOMALY_INCIDENT_RETENTION_DAYS, 14, MAX_RETENTION_DAYS, LOG_PREFIX);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'METRIC_ANOMALY_INCIDENT_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'METRIC_ANOMALY_INCIDENT_RETENTION_MAX_BATCHES', 50);

let retentionQueue: Queue | null = null;

export function getMetricAnomalyIncidentRetentionQueue(): Queue {
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

export function createMetricAnomalyIncidentRetentionWorker(): Worker<RetentionJobData> {
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
        table: 'metric_anomaly_incidents',
        where: sql`(
          ${metricAnomalyIncidents.dispatchedAt} IS NOT NULL AND ${metricAnomalyIncidents.dispatchedAt} < ${cutoff}::timestamptz
        ) OR (
          ${metricAnomalyIncidents.dispatchedAt} IS NULL
          AND ${metricAnomalyIncidents.dispatchAttempts} > ${MAX_PUBLISH_ATTEMPTS}
          AND ${metricAnomalyIncidents.createdAt} < ${cutoff}::timestamptz
        )`,
        batchSize,
        maxBatches,
        label: 'metricAnomalyIncidentRetention.prune',
      });

      const durationMs = Date.now() - startTime;
      console.log(`${LOG_PREFIX} Pruned ${deletedCount} metric_anomaly_incidents rows older than ${retentionDays} days (batches=${batches}) in ${durationMs}ms`);
      warnOnRetentionBacklog(LOG_PREFIX, 'metric_anomaly_incidents', { deleted: deletedCount, batches, hasMore });
      recordRetentionRun('metric_anomaly_incident_retention', { rowsDeleted: deletedCount, incomplete: hasMore });

      return { durationMs, deletedCount, retentionDays, batches, hasMore };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeMetricAnomalyIncidentRetention(): Promise<void> {
  try {
    retentionWorker = createMetricAnomalyIncidentRetentionWorker();
    attachWorkerObservability(retentionWorker, 'metricAnomalyIncidentRetention');

    retentionWorker.on('error', (error) => {
      console.error('[MetricAnomalyIncidentRetention] Worker error:', error);
    });

    const queue = getMetricAnomalyIncidentRetentionQueue();

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
        repeat: { pattern: jobSchedule('metric-anomaly-incident-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log('[MetricAnomalyIncidentRetention] Retention worker initialized');
  } catch (error) {
    console.error('[MetricAnomalyIncidentRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMetricAnomalyIncidentRetention(): Promise<void> {
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
