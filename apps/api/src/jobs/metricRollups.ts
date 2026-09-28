import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { isReusableState } from '../services/bullmqUtils';
import { rollupDeviceMetricsRange, type MetricRollupResult } from '../services/metricRollups';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';

const METRIC_ROLLUPS_QUEUE = 'metric-rollups';
const DEFAULT_LOOKBACK_MINUTES = 15;
const JOB_REUSE_STATES = new Set(['waiting', 'delayed', 'active']);

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt?: string;
  lookbackMinutes?: number;
};

type RollupOrgRangeJobData = {
  type: 'rollup-org-range';
  orgId: string;
  from: string;
  to: string;
  queuedAt: string;
  /**
   * #4276 — hour→day pass plan, serialized form of `MetricRollupRange.dayRollups`.
   * Absent on backfills and on jobs queued before this field existed; both get
   * the service default (days touched by the window).
   */
  dayRollups?: 'skip' | { from: string };
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

const HOUR_MS = 60 * 60 * 1000;
/** The one scheduled run per hour that also re-derives day buckets: the run ending at hh:15. */
const DAY_ROLLUP_RUN_OFFSET_MS = 15 * 60 * 1000;
/** How far before the raw window a day run reaches, so lost day runs are caught up. */
const DAY_ROLLUP_CATCH_UP_MS = 3 * HOUR_MS;

/**
 * #4276 — which scheduled runs re-derive the day-level rollups, and over what.
 *
 * A day bucket is a full re-aggregate of its day's hourly rows, so on every
 * 5-minute run it cost O(hours elapsed today) per device×series and made
 * `metricRollupsWorker` the top `db_context_held_too_long` offender. It now
 * runs on one run per hour (the one whose window ends at hh:15); the other
 * eleven skip it. The day bucket for the current day therefore lags by up to
 * an hour. Readers of 86400-second buckets (capacity forecasts, 24h/7d/30d
 * trends, the device `1d` interval) chart whole days, where an hour of lag on
 * the still-open current day is tolerable.
 *
 * Correctness: a run over [T-15m, T) rewrites the hourly rollups of the hours
 * it overlaps, and the day holding each of those hours must be re-derived by a
 * later day run. A day run over [from - 3h, to) covers every day touched by
 * the hours changed since the previous day run with margin for two lost day
 * runs — including the previous day's last hour, which keeps changing on the
 * 00:05 and 00:10 runs after midnight. Pinned by the schedule walk in
 * `metricRollups.test.ts`.
 */
export function scheduledDayRollups(window: { from: Date; to: Date }): 'skip' | { from: Date } {
  const isDayRun = window.to.getTime() % HOUR_MS === DAY_ROLLUP_RUN_OFFSET_MS;
  if (!isDayRun) {
    // The catch-up above assumes a skip run rewrites at most the default
    // lookback. A hand-queued scan with a longer `lookbackMinutes` rewrites
    // hours the next day run would not reach, so it folds its own days.
    const windowMs = window.to.getTime() - window.from.getTime();
    return windowMs > DEFAULT_LOOKBACK_MINUTES * 60 * 1000 ? { from: window.from } : 'skip';
  }
  return { from: new Date(window.from.getTime() - DAY_ROLLUP_CATCH_UP_MS) };
}

// Quick Support exclusion: ephemeral devices (`devices.is_ephemeral`) live in
// the hidden per-partner 'quick_support' org and are a stranger's personal
// machine borrowed for one ~20-minute session. That org stays inside
// technicians' accessibleOrgIds for RLS reasons, so this fleet-wide sweep is NOT
// filtered for us; excluding the devices also drops the hidden org out of the
// fan-out entirely (it holds nothing but ephemeral devices).
async function findRollupOrgRows(): Promise<Array<{ orgId: string }>> {
  return db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(sql`${devices.status} <> 'decommissioned' AND ${devices.isEphemeral} = false AND ${notParkedDeviceCondition()}`)
    .groupBy(devices.orgId);
}

async function processScanOrgs(data: ScanOrgsJobData): Promise<{ queued: number }> {
  const orgRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => findRollupOrgRows(), 'metricRollups.scanOrgs')
  );

  if (orgRows.length === 0) {
    return { queued: 0 };
  }

  const scannedAt = new Date();
  const queuedAt = scannedAt.toISOString();
  const { from, to } = recentWindow(scannedAt, data.lookbackMinutes);
  const dayPlan = scheduledDayRollups({ from, to });
  const dayRollups = dayPlan === 'skip' ? 'skip' : { from: dayPlan.from.toISOString() };
  const queue = getMetricRollupsQueue();
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'rollup-org-range',
      data: {
        type: 'rollup-org-range' as const,
        orgId: row.orgId,
        from: from.toISOString(),
        to: to.toISOString(),
        queuedAt,
        dayRollups,
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
    ...(data.dayRollups === undefined
      ? {}
      : { dayRollups: data.dayRollups === 'skip' ? 'skip' : { from: new Date(data.dayRollups.from) } }),
  });
}

export function createMetricRollupsWorker(): Worker<MetricRollupJobData> {
  return new Worker<MetricRollupJobData>(
    METRIC_ROLLUPS_QUEUE,
    async (job: Job<MetricRollupJobData>) => {
      if (job.data.type === 'scan-orgs') {
        return processScanOrgs(job.data);
      }
      const data = job.data;
      // No worker-level system context here (#4276): rollupDeviceMetricsRange
      // owns one short-lived labeled context PER statement, each preceded by
      // its own runOutsideDbContext escape. A wrap here would not be joined —
      // the escape defeats it — it would just pin an idle-in-transaction
      // connection for the whole pass (an unlabeled hold, plus a second pool
      // slot). This outer runOutsideDbContext is belt-and-braces against a
      // future ambient context on this path.
      return runOutsideDbContext(() => processRollupOrgRange(data));
    },
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
  attachWorkerObservability(metricRollupsWorker, 'metricRollupsWorker');
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
