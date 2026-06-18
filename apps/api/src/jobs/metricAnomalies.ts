import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { isReusableState } from '../services/bullmqUtils';
import { detectMetricAnomaliesRange, type MetricAnomalyResult } from '../services/metricAnomalies';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const METRIC_ANOMALIES_QUEUE = 'metric-anomalies';
const DEFAULT_LOOKBACK_MINUTES = 30;
const JOB_REUSE_STATES = new Set(['waiting', 'delayed', 'active']);

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt?: string;
  lookbackMinutes?: number;
};

type DetectOrgRangeJobData = {
  type: 'detect-org-range';
  orgId: string;
  from: string;
  to: string;
  queuedAt: string;
};

export type MetricAnomalyJobData = ScanOrgsJobData | DetectOrgRangeJobData;

let metricAnomaliesQueue: Queue<MetricAnomalyJobData> | null = null;
let metricAnomaliesWorker: Worker<MetricAnomalyJobData> | null = null;

export function getMetricAnomaliesQueue(): Queue<MetricAnomalyJobData> {
  if (!metricAnomaliesQueue) {
    metricAnomaliesQueue = new Queue<MetricAnomalyJobData>(METRIC_ANOMALIES_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return metricAnomaliesQueue;
}

function compactIso(value: Date | string): string {
  return new Date(value).toISOString().replace(/[^0-9A-Za-z]/g, '');
}

export function buildMetricAnomalyJobId(orgId: string, from: Date | string, to: Date | string): string {
  return ['metric-anomalies', orgId, compactIso(from), compactIso(to)].join('-');
}

function recentWindow(now = new Date(), lookbackMinutes = DEFAULT_LOOKBACK_MINUTES): { from: Date; to: Date } {
  const bucketMs = 5 * 60 * 1000;
  const to = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
  const from = new Date(to.getTime() - lookbackMinutes * 60 * 1000);
  return { from, to };
}

async function processScanOrgs(data: ScanOrgsJobData): Promise<{ queued: number }> {
  const orgRows = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(sql`${devices.status} <> 'decommissioned'`)
    .groupBy(devices.orgId);

  if (orgRows.length === 0) {
    return { queued: 0 };
  }

  const scannedAt = new Date();
  const queuedAt = scannedAt.toISOString();
  const { from, to } = recentWindow(scannedAt, data.lookbackMinutes);
  const queue = getMetricAnomaliesQueue();
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'detect-org-range',
      data: {
        type: 'detect-org-range' as const,
        orgId: row.orgId,
        from: from.toISOString(),
        to: to.toISOString(),
        queuedAt,
      },
      opts: {
        jobId: buildMetricAnomalyJobId(row.orgId, from, to),
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }))
  );

  return { queued: orgRows.length };
}

async function processDetectOrgRange(data: DetectOrgRangeJobData): Promise<MetricAnomalyResult> {
  return detectMetricAnomaliesRange({
    orgId: data.orgId,
    from: new Date(data.from),
    to: new Date(data.to),
  });
}

export function createMetricAnomaliesWorker(): Worker<MetricAnomalyJobData> {
  return new Worker<MetricAnomalyJobData>(
    METRIC_ANOMALIES_QUEUE,
    async (job: Job<MetricAnomalyJobData>) =>
      withSystemDbAccessContext(async () => {
        if (job.data.type === 'scan-orgs') {
          return processScanOrgs(job.data);
        }
        return processDetectOrgRange(job.data);
      }),
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

async function scheduleMetricAnomaliesScan(): Promise<void> {
  const queue = getMetricAnomaliesQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'scan-orgs') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'scan-orgs',
    {
      type: 'scan-orgs',
      lookbackMinutes: DEFAULT_LOOKBACK_MINUTES,
    },
    {
      jobId: 'metric-anomalies-scan-orgs',
      repeat: { pattern: '*/10 * * * *' },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 100 },
    }
  );
}

export async function initializeMetricAnomaliesWorker(): Promise<void> {
  metricAnomaliesWorker = createMetricAnomaliesWorker();
  attachWorkerObservability(metricAnomaliesWorker, 'metricAnomaliesWorker');
  metricAnomaliesWorker.on('error', (error) => {
    console.error('[MetricAnomaliesWorker] Worker error:', error);
  });
  metricAnomaliesWorker.on('failed', (job, error) => {
    console.error(`[MetricAnomaliesWorker] Job ${job?.id} (${job?.data?.type}) failed:`, error);
  });
  await scheduleMetricAnomaliesScan();
  console.log('[MetricAnomaliesWorker] Metric anomalies worker initialized');
}

export async function shutdownMetricAnomaliesWorker(): Promise<void> {
  if (metricAnomaliesWorker) {
    await metricAnomaliesWorker.close();
    metricAnomaliesWorker = null;
  }
  if (metricAnomaliesQueue) {
    await metricAnomaliesQueue.close();
    metricAnomaliesQueue = null;
  }
}

export async function enqueueMetricAnomalyBackfill(options: {
  orgId: string;
  from: Date;
  to: Date;
}): Promise<string> {
  const queue = getMetricAnomaliesQueue();
  const jobId = buildMetricAnomalyJobId(options.orgId, options.from, options.to);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (JOB_REUSE_STATES.has(state) || isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[MetricAnomaliesWorker] Failed to remove stale job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'detect-org-range',
    {
      type: 'detect-org-range',
      orgId: options.orgId,
      from: options.from.toISOString(),
      to: options.to.toISOString(),
      queuedAt: new Date().toISOString(),
    },
    {
      jobId,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    }
  );

  return String(job.id);
}
