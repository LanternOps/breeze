import { eq, sql } from 'drizzle-orm';
import { Job, Queue, Worker } from 'bullmq';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations } from '../db/schema';
import { produceLogCorrelationFindings, produceMetricAnomalyPatterns, produceReliabilityOffenders } from '../services/fleetFindings/producers';
import { reconcileOrgFindings, type ReconcileResult } from '../services/fleetFindings/reconcile';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const FLEET_FINDINGS_QUEUE = 'fleet-findings';
const SCAN_ORGS_JOB_ID = 'fleet-findings-scan';
const SCAN_REPEAT_CRON = '*/10 * * * *';

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt?: string;
};

type ProcessOrgJobData = {
  type: 'process-org';
  orgId: string;
  queuedAt: string;
};

export type FleetFindingsJobData = ScanOrgsJobData | ProcessOrgJobData;

export type ProcessOrgResult =
  | { skipped: true }
  | ({ skipped: false } & ReconcileResult);

let fleetFindingsQueue: Queue<FleetFindingsJobData> | null = null;
let fleetFindingsWorker: Worker<FleetFindingsJobData> | null = null;

export function getFleetFindingsQueue(): Queue<FleetFindingsJobData> {
  if (!fleetFindingsQueue) {
    fleetFindingsQueue = new Queue<FleetFindingsJobData>(FLEET_FINDINGS_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return fleetFindingsQueue;
}

function compactIso(value: Date | string): string {
  return new Date(value).toISOString().replace(/[^0-9A-Za-z]/g, '');
}

// Must match SCAN_REPEAT_CRON's cadence: floors `now` to the 10-minute slot
// it falls in, so every scan cycle mints a fresh dedupe key while duplicate
// adds within the same cycle (e.g. a retried scan-orgs job) still collapse
// onto the same jobId. Mirrors the bucket-floor approach of
// jobs/metricRollups.ts's buildMetricRollupJobId — not its parameters: that
// one floors to 5-minute buckets and keys on a (from, to) pair, this one uses
// a single 10-minute slot.
const SCAN_SLOT_BUCKET_MS = 10 * 60 * 1000;

export function fleetFindingsScanSlot(now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / SCAN_SLOT_BUCKET_MS) * SCAN_SLOT_BUCKET_MS);
}

// BullMQ dedupes new `add`/`addBulk` calls against a job's key even after
// it's completed and retained via `removeOnComplete`, so a static per-org
// jobId (no scan-slot suffix) would silently swallow every scan after the
// first one. Windowing by scanSlot gives each 10-minute cycle a fresh key.
export function buildFleetFindingsOrgJobId(orgId: string, scanSlot: Date | string): string {
  return ['fleet-findings-org', orgId, compactIso(scanSlot)].join('-');
}

// Same fan-out source as metricRollups: orgs with at least one live, non-ephemeral
// device. Quick Support's hidden per-partner org holds only ephemeral devices and
// is excluded for the same reason documented in jobs/metricRollups.ts.
async function findFleetFindingsOrgRows(): Promise<Array<{ orgId: string }>> {
  return db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(sql`${devices.status} <> 'decommissioned' AND ${devices.isEphemeral} = false`)
    .groupBy(devices.orgId);
}

/**
 * `organizations.settings->fleet->findings->enabled`. Absent (org, `fleet`,
 * `findings`, or the flag itself missing) defaults to enabled; only an
 * explicit `false` skips the org.
 */
export function isFleetFindingsEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const fleet = (settings as Record<string, unknown>).fleet;
  if (!fleet || typeof fleet !== 'object' || Array.isArray(fleet)) return true;
  const findings = (fleet as Record<string, unknown>).findings;
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) return true;
  return (findings as Record<string, unknown>).enabled !== false;
}

async function processScanOrgs(): Promise<{ queued: number }> {
  const orgRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => findFleetFindingsOrgRows())
  );

  if (orgRows.length === 0) {
    return { queued: 0 };
  }

  const now = new Date();
  const queuedAt = now.toISOString();
  const scanSlot = fleetFindingsScanSlot(now);
  const queue = getFleetFindingsQueue();
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'process-org',
      data: {
        type: 'process-org' as const,
        orgId: row.orgId,
        queuedAt,
      },
      opts: {
        jobId: buildFleetFindingsOrgJobId(row.orgId, scanSlot),
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }))
  );

  return { queued: orgRows.length };
}

async function processOrg(data: ProcessOrgJobData): Promise<ProcessOrgResult> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, data.orgId))
    .limit(1);

  // No org row: the org was deleted between scan-orgs fan-out and this job
  // running. `org?.settings` would be `undefined`, which
  // `isFleetFindingsEnabled` reads as "absent settings -> enabled" — the right
  // default for a live org, exactly wrong for one that no longer exists. Skip
  // rather than run three producers and a reconcile against a dead tenant.
  if (!org) {
    console.warn(`[fleetFindings] processOrg: org ${data.orgId} not found — skipping scan`);
    return { skipped: true };
  }

  if (!isFleetFindingsEnabled(org.settings)) {
    return { skipped: true };
  }

  const candidates = [
    ...(await produceMetricAnomalyPatterns(data.orgId)),
    ...(await produceLogCorrelationFindings(data.orgId)),
    ...(await produceReliabilityOffenders(data.orgId)),
  ];

  const result = await reconcileOrgFindings(data.orgId, candidates);
  return { skipped: false, ...result };
}

export function createFleetFindingsWorker(): Worker<FleetFindingsJobData> {
  return new Worker<FleetFindingsJobData>(
    FLEET_FINDINGS_QUEUE,
    async (job: Job<FleetFindingsJobData>) => {
      if (job.data.type === 'scan-orgs') {
        return processScanOrgs();
      }
      const data = job.data;
      // One org's throw only fails that org's job — BullMQ isolates per-job
      // failures, so it cannot abort the scan or any sibling org's job.
      return runOutsideDbContext(() => withSystemDbAccessContext(() => processOrg(data)));
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

async function scheduleFleetFindingsScan(): Promise<void> {
  const queue = getFleetFindingsQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'scan-orgs') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'scan-orgs',
    { type: 'scan-orgs' },
    {
      jobId: SCAN_ORGS_JOB_ID,
      repeat: { pattern: SCAN_REPEAT_CRON },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 100 },
    }
  );
}

export async function scheduleFleetFindingsJobs(): Promise<void> {
  fleetFindingsWorker = createFleetFindingsWorker();
  attachWorkerObservability(fleetFindingsWorker, 'fleetFindingsWorker');
  fleetFindingsWorker.on('error', (error) => {
    console.error('[FleetFindingsWorker] Worker error:', error);
  });
  fleetFindingsWorker.on('failed', (job, error) => {
    console.error(`[FleetFindingsWorker] Job ${job?.id} (${job?.data?.type}) failed:`, error);
  });
  await scheduleFleetFindingsScan();
  console.log('[FleetFindingsWorker] Fleet findings worker initialized');
}

export async function shutdownFleetFindingsJobs(): Promise<void> {
  if (fleetFindingsWorker) {
    await fleetFindingsWorker.close();
    fleetFindingsWorker = null;
  }
  if (fleetFindingsQueue) {
    await fleetFindingsQueue.close();
    fleetFindingsQueue = null;
  }
}
