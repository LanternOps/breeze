import { DelayedError, Job, Queue, Worker, type JobsOptions } from 'bullmq';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { devices, securityScans } from '../db/schema';
import { isCronDue } from '../services/cronDue';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { attachWorkerObservability } from './workerObservability';
import { securityScanQueueJobDataSchema, type SecurityScanQueueJobData } from './queueSchemas';
import {
  resolveAllSecurityScanScheduledDevices,
  resolveSecurityScanPolicyForDevice,
  resolvePartnerTimezoneForOrg,
  type SecurityScanSchedulable,
} from '../services/featureConfigResolver';
import { securityScanCron, type SecurityScanSettings } from '@breeze/shared';
import { notParkedDeviceCondition } from '../services/unassignedPool/selectorPredicate';
import { parsePositiveIntEnv } from '../services/securityScanSweepConfig';
import { claimAndDispatchScan, type ClaimOutcome, type DispatchScanJobData } from './securityScanClaim';
import { pumpSweeps, type SweepDispatchJob } from './securityScanSweepPump';
import { captureException } from '../services/sentry';

// #6263 W05: the payload builder moved next to the claim, its only queued caller.
export { buildSecurityScanPayload } from '../services/securityScanPayload';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SECURITY_SCAN_QUEUE = 'security-scan';
const POLICY_SCAN_INTERVAL_MS = 60 * 1000;

// The org (40) and device (1) running caps are read by the claim
// (jobs/securityScanClaim.ts), under the partner lock.
const SECURITY_SCAN_WORKER_CONCURRENCY = parsePositiveIntEnv('SECURITY_SCAN_WORKER_CONCURRENCY', 6);
const SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT =
  parsePositiveIntEnv('SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT', 500);
// #6263 W05 — the sweep pump's cadence. A same-file const so the schedule
// registry contract can read the repeat statically.
const SECURITY_SWEEP_PUMP_INTERVAL_MS = parsePositiveIntEnv('SECURITY_SWEEP_PUMP_INTERVAL_MS', 30_000);
const SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS =
  parsePositiveIntEnv('SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS', 20);

type SchedulePoliciesJobData = Extract<SecurityScanQueueJobData, { type: 'schedule-policies' }>;

let securityScanQueue: Queue<SecurityScanQueueJobData> | null = null;
let securityScanWorker: Worker<SecurityScanQueueJobData> | null = null;

export function getSecurityScanQueue(): Queue<SecurityScanQueueJobData> {
  if (!securityScanQueue) {
    securityScanQueue = new Queue<SecurityScanQueueJobData>(SECURITY_SCAN_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return securityScanQueue;
}

const dispatchJobId = (scanId: string) => `security-scan-${scanId}`;

/**
 * A claim that THROWS (a deadlock, a lost connection) rolls back and leaves
 * the scan queued; without attempts a scheduled or manual scan would then never
 * be retried. The claim is a CAS, so a retry is safe. Throttles re-delay via
 * DelayedError and do not consume attempts.
 */
const DISPATCH_RETRY = { attempts: 3, backoff: { type: 'exponential' as const, delay: 5_000 } };

async function addUniqueDispatchJob(
  data: DispatchScanJobData,
  opts: Omit<JobsOptions, 'jobId'> = {},
) {
  const queue = getSecurityScanQueue();
  const stableJobId = dispatchJobId(data.scanId);
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) return existing;
    await existing.remove().catch((error) => {
      console.error('[SecurityScanJobs] Failed to remove stale job:', error);
    });
  }
  return queue.add('dispatch-scan', data, {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
    ...DISPATCH_RETRY,
    jobId: stableJobId,
    ...opts,
  });
}

export async function enqueueSecurityScan(scanId: string): Promise<string | null> {
  const job = await addUniqueDispatchJob({ type: 'dispatch-scan', scanId, origin: 'manual' });
  return typeof job.id === 'string' ? job.id : job.id ? String(job.id) : null;
}

/**
 * #6263 W05 — nudge the sweep pump right after a create commits. One
 * coalescing job id: a burst of creates queues at most one immediate pump
 * (BullMQ ignores an add whose id already exists), and the repeatable tick
 * admits anything this misses.
 */
export async function enqueueSweepPump(): Promise<void> {
  await getSecurityScanQueue().add(
    'pump-sweeps',
    { type: 'pump-sweeps', tickAt: new Date().toISOString() },
    { jobId: 'security-sweep-pump-now', removeOnComplete: true, removeOnFail: true },
  );
}

/** #6263 W05 — the pump's admissions, each on the stable per-scan job id. */
export async function enqueueSweepDispatches(jobs: readonly SweepDispatchJob[]): Promise<void> {
  // One failing add must not starve the rest of the batch: the rows stay
  // queued and the next tick re-admits whatever did not make it.
  let failed = 0;
  for (const job of jobs) {
    try {
      await addUniqueDispatchJob(job);
    } catch (error) {
      failed++;
      if (failed === 1) captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failed > 0) {
    console.error(`[SecurityScanJobs] ${failed}/${jobs.length} sweep dispatch job(s) could not be enqueued; the next pump tick retries`);
  }
}

/**
 * Backpressure counts scans that are actually waiting on the queue. A queued
 * SWEEP scan is not in flight — it waits in the database for the pump — so
 * 10,000 offline sweep targets cannot starve the scheduler (#6263 W05-2).
 */
async function getOrgQueuedScans(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(securityScans)
    .where(and(eq(securityScans.orgId, orgId), eq(securityScans.status, 'queued'), isNull(securityScans.sweepId)));
  return Number(row?.count ?? 0);
}

/**
 * Dispatch one queued scan through the locked claim (jobs/securityScanClaim.ts).
 *
 * A throttled scan (org / partner / device cap) is re-delayed IN PLACE: the
 * running job moves itself to the delayed set under its own lock token and
 * throws BullMQ's DelayedError (the scriptReviewWorker.ts mechanism). Before
 * #6263 W05 it called addUniqueDispatchJob from inside the running job, which
 * found that same active job by its stable id, treated it as reusable and
 * scheduled nothing — a throttled scheduled or manual scan stayed `queued`
 * forever. A throttled SWEEP scan is left `queued` instead: the pump re-admits
 * it when the device or org has room, without a delayed-job loop per device.
 */
export async function processDispatchScan(
  data: DispatchScanJobData,
  job?: Pick<Job, 'moveToDelayed'>,
  token?: string,
): Promise<ClaimOutcome> {
  const result = await claimAndDispatchScan(data);
  if (result.outcome !== 'throttled' || data.origin === 'sweep') return result;

  const delayMs = SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS * 1000;
  console.warn(`[SecurityScanJobs] scan ${data.scanId} throttled: ${result.throttleReason}; retrying in ${delayMs} ms`);
  if (job && token) {
    await job.moveToDelayed(Date.now() + delayMs, token);
    throw new DelayedError();
  }
  // No lock token to re-delay with: queue a fresh delayed job under its own id
  // rather than drop the retry. The claim is a CAS, so a duplicate is a no-op.
  await getSecurityScanQueue().add('dispatch-scan', data, {
    delay: delayMs,
    jobId: `${dispatchJobId(data.scanId)}-retry-${Date.now()}`,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  });
  return result;
}

/** Truncate to the minute — the occurrence identity for idempotency. */
function occurrenceStart(now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  return d;
}

export function shouldScheduleSecurityScan(
  settings: SecurityScanSettings,
  timezone: string,
  now: Date,
): boolean {
  const cron = securityScanCron(settings);
  if (!cron) return false;
  return isCronDue(cron, timezone || 'UTC', now);
}

/**
 * Create + enqueue scans for ONE due policy. Exported so an integration test can
 * prove the partner-wide device fan-out against real Postgres.
 *
 * Every row takes the DEVICE's org: identical to the policy's org for an
 * org-owned policy, and the only correct org for a partner-wide one.
 * `initiated_by` is NULL — a scheduled scan has no human actor, and NULL is
 * already allowed (`security_scans.initiated_by` is nullable).
 */
export async function schedulePolicyScans(
  entry: SecurityScanSchedulable,
  now: Date,
): Promise<number> {
  if (entry.deviceIds.length === 0) return 0;
  const occurrence = occurrenceStart(now);

  const deviceRows = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(and(
      inArray(devices.id, entry.deviceIds),
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
      ne(devices.status, 'decommissioned'),
    ));
  if (deviceRows.length === 0) return 0;

  // Per-org backpressure, evaluated per member org so one saturated org under a
  // partner-wide policy cannot starve the rest.
  const admittedOrgIds = new Set<string>();
  const backpressured: string[] = [];
  for (const orgId of new Set(deviceRows.map((d) => d.orgId))) {
    if (await getOrgQueuedScans(orgId) < SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT) {
      admittedOrgIds.add(orgId);
    } else {
      backpressured.push(orgId);
    }
  }
  if (backpressured.length > 0) {
    console.warn(
      `[SecurityScanJobs] policy ${entry.configPolicyId}: skipped ${backpressured.length} `
      + `backpressured org(s) this cycle: ${backpressured.join(', ')}`,
    );
  }

  // Occurrence idempotency (plan DECISION 2): skip a device that is already
  // queued/running, or that already started a scan inside this cron minute.
  const busy = await db
    .select({ deviceId: securityScans.deviceId })
    .from(securityScans)
    .where(and(
      inArray(securityScans.deviceId, deviceRows.map((d) => d.id)),
      // A queued SWEEP scan is not in flight and was inserted with
      // started_at = now(): the exclusion wraps the WHOLE predicate, or it
      // would also block this cron minute (#6263 W05-2).
      sql`NOT (${securityScans.sweepId} IS NOT NULL AND ${securityScans.status} = 'queued') AND (${securityScans.status} IN ('queued','running') OR ${securityScans.startedAt} >= ${occurrence})`,
    ));
  const busyIds = new Set(busy.map((b) => b.deviceId));

  const targets = deviceRows.filter((d) => admittedOrgIds.has(d.orgId) && !busyIds.has(d.id));
  if (targets.length === 0) return 0;

  const created = await db
    .insert(securityScans)
    .values(targets.map((device) => ({
      orgId: device.orgId,
      deviceId: device.id,
      scanType: entry.settings.scanType,
      status: 'queued',
      startedAt: occurrence,
      initiatedBy: null,
    })))
    .returning({ id: securityScans.id });

  await getSecurityScanQueue().addBulk(created.map((scan) => ({
    name: 'dispatch-scan',
    data: {
      type: 'dispatch-scan' as const,
      scanId: scan.id,
      origin: 'policy_scheduler' as const,
      configPolicyId: entry.configPolicyId,
      occurrenceIso: occurrence.toISOString(),
    },
    opts: {
      jobId: dispatchJobId(scan.id),
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      ...DISPATCH_RETRY,
    },
  })));

  return created.length;
}

async function processSchedulePolicies(data: SchedulePoliciesJobData): Promise<{
  scheduledPolicies: number;
  scansQueued: number;
}> {
  const parsed = new Date(data.scanAt);
  const now = Number.isFinite(parsed.getTime()) ? parsed : new Date();

  const entries = await resolveAllSecurityScanScheduledDevices();
  let scheduledPolicies = 0;
  let scansQueued = 0;
  const timezoneByOrg = new Map<string, string>();

  for (const entry of entries) {
    // Timezone: the owning org's partner timezone, else UTC. A partner-wide
    // policy (orgId NULL) has no org of its own, so it falls back to UTC rather
    // than silently borrowing one member org's clock.
    let timezone = 'UTC';
    if (entry.orgId) {
      if (!timezoneByOrg.has(entry.orgId)) {
        timezoneByOrg.set(entry.orgId, (await resolvePartnerTimezoneForOrg(entry.orgId)) ?? 'UTC');
      }
      timezone = timezoneByOrg.get(entry.orgId)!;
    }
    if (!shouldScheduleSecurityScan(entry.settings, timezone, now)) continue;

    const queued = await schedulePolicyScans(entry, now);
    if (queued > 0) {
      scansQueued += queued;
      scheduledPolicies++;
    }
  }

  return { scheduledPolicies, scansQueued };
}

export function createSecurityScanWorker(): Worker<SecurityScanQueueJobData> {
  return new Worker<SecurityScanQueueJobData>(
    SECURITY_SCAN_QUEUE,
    async (job: Job<SecurityScanQueueJobData>, token?: string) => {
      const data = parseQueueJobData(SECURITY_SCAN_QUEUE, job, securityScanQueueJobDataSchema);
      // The claim and the pump open their own system transactions: delivery
      // and job enqueues must follow a commit, never sit inside one.
      if (data.type === 'dispatch-scan') {
        assertQueueJobName(SECURITY_SCAN_QUEUE, job, 'dispatch-scan');
        return processDispatchScan(data, job, token);
      }
      if (data.type === 'pump-sweeps') {
        assertQueueJobName(SECURITY_SCAN_QUEUE, job, 'pump-sweeps');
        // The wall clock, never `data.tickAt`: a repeatable job reuses the
        // data it was registered with, so every repeat would carry boot time
        // and expiry / the stale-scan ceiling would never advance.
        return pumpSweeps(new Date(), { enqueue: enqueueSweepDispatches });
      }
      assertQueueJobName(SECURITY_SCAN_QUEUE, job, 'schedule-policies');
      return runWithSystemDbAccess(() => processSchedulePolicies(data));
    },
    {
      connection: getBullMQConnection(),
      concurrency: SECURITY_SCAN_WORKER_CONCURRENCY,
      lockDuration: 120_000,
      lockRenewTime: 60_000,
    },
  );
}

async function schedulePolicyTick(): Promise<void> {
  const queue = getSecurityScanQueue();
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === 'schedule-policies' || job.name === 'pump-sweeps') await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'schedule-policies',
    { type: 'schedule-policies', scanAt: new Date().toISOString() },
    { repeat: { every: POLICY_SCAN_INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } },
  );
  // #6263 W05 — the sweep pump's repeatable tick (stale ones removed above).
  await queue.add(
    'pump-sweeps',
    { type: 'pump-sweeps', tickAt: new Date().toISOString() },
    { repeat: { every: SECURITY_SWEEP_PUMP_INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } },
  );
}

export async function initializeSecurityScanWorkers(): Promise<void> {
  securityScanWorker = createSecurityScanWorker();
  attachWorkerObservability(securityScanWorker, 'securityScanWorker');
  securityScanWorker.on('error', (error) => {
    console.error('[SecurityScanWorker] Worker error:', error);
  });
  securityScanWorker.on('failed', (job, error) => {
    console.error(`[SecurityScanWorker] Job ${job?.id} failed:`, error);
  });
  await schedulePolicyTick();
  console.log('[SecurityScanWorker] Security scan workers initialized');
}

export async function shutdownSecurityScanWorkers(): Promise<void> {
  if (securityScanWorker) { await securityScanWorker.close(); securityScanWorker = null; }
  if (securityScanQueue) { await securityScanQueue.close(); securityScanQueue = null; }
}
