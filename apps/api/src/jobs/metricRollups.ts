import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { isReusableState } from '../services/bullmqUtils';
import { rollupDeviceMetricsRange, type MetricRollupResult } from '../services/metricRollups';
import { getBullMQConnection } from '../services/redis';

const METRIC_ROLLUPS_QUEUE = 'metric-rollups';
const DEFAULT_LOOKBACK_MINUTES = 15;
const JOB_REUSE_STATES = new Set(['waiting', 'delayed', 'active']);

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt: string;
  lookbackMinutes?: number;
};

type RollupOrgRangeJobData = {
  type: 'rollup-org-range';
  orgId: string;
  from: string;
  to: string;
  queuedAt: string;
};

export type MetricRollupJobData = ScanOrgsJobData | RollupOrgRangeJobData;

let metricRollupsQueue: Queue<MetricRollupJobData> | null = null;
let metricRollupsWorker: Worker<MetricRollupJobData> | null = null;

export function getMetricRollupsQueue(): Queue<MetricRollupJobData> {
  if (!metricRollupsQueue) {
    metricRollupsQueue = new Queue<MetricRollupJobData>(METRIC_ROLLUPS_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return metricRollupsQueue;
}

function compactIso(value: Date | string): string {
  return new Date(value).toISOString().replace(/[^0-9A-Za-z]/g, '');
}

export function buildMetricRollupJobId(orgId: string, from: Date | string, to: Date | string): string {
  return ['metric-rollups', orgId, compactIso(from), compactIso(to)].join('-');
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

  const { from, to } = recentWindow(new Date(data.queuedAt), data.lookbackMinutes);
  const queue = getMetricRollupsQueue();
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'rollup-org-range',
      data: {
        type: 'rollup-org-range' as const,
        orgId: row.orgId,
        from: from.toISOString(),
        to: to.toISOString(),
        queuedAt: data.queuedAt,
      },
      opts: {
        jobId: buildMetricRollupJobId(row.orgId, from, to),
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }))
  );

  return { queued: orgRows.length };
}

async function processRollupOrgRange(data: RollupOrgRangeJobData): Promise<MetricRollupResult> {
  return rollupDeviceMetricsRange({
    orgId: data.orgId,
    from: new Date(data.from),
    to: new Date(data.to),
  });
}

export function createMetricRollupsWorker(): Worker<MetricRollupJobData> {
  return new Worker<MetricRollupJobData>(
    METRIC_ROLLUPS_QUEUE,
    async (job: Job<MetricRollupJobData>) =>
      withSystemDbAccessContext(async () => {
        if (job.data.type === 'scan-orgs') {
          return processScanOrgs(job.data);
        }
        return processRollupOrgRange(job.data);
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

async function scheduleMetricRollupsScan(): Promise<void> {
  const queue = getMetricRollupsQueue();
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
      queuedAt: new Date().toISOString(),
      lookbackMinutes: DEFAULT_LOOKBACK_MINUTES,
    },
    {
      jobId: 'metric-rollups-scan-orgs',
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 100 },
    }
  );
}

export async function initializeMetricRollupsWorker(): Promise<void> {
  metricRollupsWorker = createMetricRollupsWorker();
  metricRollupsWorker.on('error', (error) => {
    console.error('[MetricRollupsWorker] Worker error:', error);
  });
  metricRollupsWorker.on('failed', (job, error) => {
    console.error(`[MetricRollupsWorker] Job ${job?.id} (${job?.data?.type}) failed:`, error);
  });
  await scheduleMetricRollupsScan();
  console.log('[MetricRollupsWorker] Metric rollups worker initialized');
}

export async function shutdownMetricRollupsWorker(): Promise<void> {
  if (metricRollupsWorker) {
    await metricRollupsWorker.close();
    metricRollupsWorker = null;
  }
  if (metricRollupsQueue) {
    await metricRollupsQueue.close();
    metricRollupsQueue = null;
  }
}

export async function enqueueMetricRollupBackfill(options: {
  orgId: string;
  from: Date;
  to: Date;
}): Promise<string> {
  const queue = getMetricRollupsQueue();
  const jobId = buildMetricRollupJobId(options.orgId, options.from, options.to);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (JOB_REUSE_STATES.has(state) || isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[MetricRollupsWorker] Failed to remove stale job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'rollup-org-range',
    {
      type: 'rollup-org-range',
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
