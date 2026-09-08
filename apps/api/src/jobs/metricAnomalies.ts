import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { isReusableState } from '../services/bullmqUtils';
import { detectMetricAnomaliesRange, type MetricAnomalyResult } from '../services/metricAnomalies';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const METRIC_ANOMALIES_QUEUE = 'metric-anomalies';
const SCAN_CRON_PATTERN = '*/10 * * * *';
const SCAN_INTERVAL_MINUTES = 10;
const RAW_BUCKET_MINUTES = 5;

/**
 * Scheduled lookback = one cron interval + one raw bucket (#5283).
 *
 * It was 30 minutes on a 10-minute cron, so consecutive windows overlapped by
 * FOUR buckets and every tick re-upserted the same `metric_anomalies` conflict
 * keys the previous tick was still holding — that overlap is what the waiting
 * PID in the incident was blocked on.
 *
 * 15 minutes is the smallest value that still cannot drop a bucket: `to` is
 * floored to a 5-minute boundary and advances 10 minutes per tick, so
 * `[11:45,12:00)` is followed by `[11:55,12:10)` — full coverage with exactly
 * one bucket of overlap. That one bucket is deliberate, not slack: it is the
 * grace period for rollups that land after the tick that would otherwise have
 * been their only chance.
 *
 * Trade-off, stated plainly: the old 30-minute window self-healed a missed tick
 * for 20 minutes. This one does not — a tick that is skipped, coalesced, or
 * lock-contended leaves buckets uncovered, and the recovery path is an explicit
 * `enqueueMetricAnomalyBackfill` over the missed range rather than "the next
 * tick will pick it up".
 */
const DEFAULT_LOOKBACK_MINUTES = SCAN_INTERVAL_MINUTES + RAW_BUCKET_MINUTES;
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

/**
 * Job id for an EXPLICIT-window run (the backfill path).
 *
 * The window is part of the id here on purpose: two backfills over different
 * ranges are different work and must both run.
 */
export function buildMetricAnomalyJobId(orgId: string, from: Date | string, to: Date | string): string {
  return ['metric-anomalies', orgId, compactIso(from), compactIso(to)].join('-');
}

/**
 * Job id for the SCHEDULED run — stable per org, with no window in it (#5283).
 *
 * The scheduled path used `buildMetricAnomalyJobId`, whose window advances
 * every cycle, so BullMQ's jobId dedup never matched and each 10-minute tick
 * enqueued a brand-new job for an org whose previous job was still running.
 * A window-free id makes the dedup do its job: while a run for this org is
 * waiting/delayed/active, the next tick reuses it instead of stacking a second.
 *
 * The cost is that a discarded tick's window is simply not covered — reusing an
 * active job does NOT extend its range. That is the intended trade (an
 * uncovered window beats an unbounded pile-up), and it is bounded by the
 * per-detector `statement_timeout` the service now sets, which stops a stuck
 * run from wedging this id indefinitely.
 */
export function buildScheduledMetricAnomalyJobId(orgId: string): string {
  return ['metric-anomalies', 'scheduled', orgId].join('-');
}

function recentWindow(now = new Date(), lookbackMinutes = DEFAULT_LOOKBACK_MINUTES): { from: Date; to: Date } {
  const bucketMs = 5 * 60 * 1000;
  const to = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
  const from = new Date(to.getTime() - lookbackMinutes * 60 * 1000);
  return { from, to };
}

// Quick Support exclusion: ephemeral devices (`devices.is_ephemeral`) live in
// the hidden per-partner 'quick_support' org and are a stranger's personal
// machine borrowed for one ~20-minute session. That org stays inside
// technicians' accessibleOrgIds for RLS reasons, so this fleet-wide sweep is NOT
// filtered for us; excluding the devices also drops the hidden org out of the
// fan-out entirely (it holds nothing but ephemeral devices).
async function findAnomalyOrgRows(): Promise<Array<{ orgId: string }>> {
  return db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(sql`${devices.status} <> 'decommissioned' AND ${devices.isEphemeral} = false`)
    .groupBy(devices.orgId);
}

async function processScanOrgs(data: ScanOrgsJobData): Promise<{ queued: number; reused: number }> {
  const orgRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => findAnomalyOrgRows())
  );

  if (orgRows.length === 0) {
    return { queued: 0, reused: 0 };
  }

  const scannedAt = new Date();
  const { from, to } = recentWindow(scannedAt, data.lookbackMinutes);

  // One `enqueueDetectOrgRange` per org rather than a single `addBulk` (#5283).
  // `addBulk` cannot express reuse-if-active: under a stable per-org job id it
  // would silently discard the add whenever ANY record survives under that id —
  // including a COMPLETED or FAILED one that `removeOnComplete`/`removeOnFail`
  // retained — which would wedge that org's detection permanently after its
  // first run. The per-org path reuses a genuinely in-flight job and replaces a
  // spent record. The extra Redis round trips are irrelevant at a 10-minute
  // cadence.
  let queued = 0;
  let reused = 0;
  for (const row of orgRows) {
    const result = await enqueueDetectOrgRange({
      jobId: buildScheduledMetricAnomalyJobId(row.orgId),
      orgId: row.orgId,
      from,
      to,
    });
    if (result.reused) {
      reused += 1;
    } else {
      queued += 1;
    }
  }

  if (reused > 0) {
    // The signal that detection is not keeping up with its own cadence. Silent
    // reuse is exactly how the original pile-up stayed invisible until Postgres
    // showed it.
    console.warn(
      `[MetricAnomaliesWorker] scan-orgs reused ${reused} in-flight detection job(s) `
        + `(${queued} newly queued) — those orgs' windows are not covered by this tick`,
    );
  }

  return { queued, reused };
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
    async (job: Job<MetricAnomalyJobData>) => {
      if (job.data.type === 'scan-orgs') {
        return processScanOrgs(job.data);
      }
      // No outer DB context here on purpose (#5283). This used to wrap the
      // whole per-org run, which made all four detector statements share ONE
      // transaction on ONE pooled connection — so a second run waited on the
      // first run's entire transactionid, not on the one statement it actually
      // conflicted with. `detectMetricAnomaliesRange` now opens a fresh
      // system-scoped transaction per stage.
      return processDetectOrgRange(job.data);
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
      repeat: { pattern: SCAN_CRON_PATTERN },
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

/**
 * Enqueue a `detect-org-range` job under `jobId`, reusing a genuinely in-flight
 * job and replacing a spent record.
 *
 * Shared by the scheduled fan-out and the backfill entry point so the
 * reuse-vs-replace rule has one home — the two differ only in how the id is
 * built (stable per org vs. window-scoped). BullMQ's own jobId dedup keys on
 * "a record exists", not "a job is pending", so a retained completed/failed
 * record would otherwise swallow every later add under the same id.
 */
async function enqueueDetectOrgRange(options: {
  jobId: string;
  orgId: string;
  from: Date;
  to: Date;
}): Promise<{ id: string; reused: boolean }> {
  const queue = getMetricAnomaliesQueue();
  const { jobId } = options;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (JOB_REUSE_STATES.has(state) || isReusableState(state)) {
      return { id: String(existing.id ?? jobId), reused: true };
    }
    await existing.remove().catch((error) => {
      console.error(`[MetricAnomaliesWorker] Failed to remove stale job ${jobId} (state '${state}'):`, error);
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

  return { id: String(job.id ?? jobId), reused: false };
}

export async function enqueueMetricAnomalyBackfill(options: {
  orgId: string;
  from: Date;
  to: Date;
}): Promise<string> {
  const { id } = await enqueueDetectOrgRange({
    jobId: buildMetricAnomalyJobId(options.orgId, options.from, options.to),
    orgId: options.orgId,
    from: options.from,
    to: options.to,
  });
  return id;
}
