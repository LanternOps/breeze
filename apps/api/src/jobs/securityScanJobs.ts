import { Job, Queue, Worker, type JobsOptions } from 'bullmq';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { devices, securityScans } from '../db/schema';
import { deviceCommands } from '../db/schema';
import { CommandTypes, queueCommandForExecution } from '../services/commandQueue';
import { isCronDue } from '../services/cronDue';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { attachWorkerObservability } from './workerObservability';
import { securityScanQueueJobDataSchema, type SecurityScanQueueJobData } from './queueSchemas';
import {
  resolveAllSecurityScanScheduledDevices,
  resolveSecurityScanSettingsForDevice,
  resolvePartnerTimezoneForOrg,
  type SecurityScanSchedulable,
} from '../services/featureConfigResolver';
import { securityScanCron, type SecurityScanSettings } from '@breeze/shared';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SECURITY_SCAN_QUEUE = 'security-scan';
const POLICY_SCAN_INTERVAL_MS = 60 * 1000;

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

const SECURITY_SCAN_WORKER_CONCURRENCY = parsePositiveIntEnv('SECURITY_SCAN_WORKER_CONCURRENCY', 6);
const SECURITY_SCAN_ORG_CONCURRENCY_CAP = parsePositiveIntEnv('SECURITY_SCAN_ORG_CONCURRENCY_CAP', 40);
const SECURITY_SCAN_DEVICE_CONCURRENCY_CAP = parsePositiveIntEnv('SECURITY_SCAN_DEVICE_CONCURRENCY_CAP', 1);
const SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT =
  parsePositiveIntEnv('SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT', 500);
const SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS =
  parsePositiveIntEnv('SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS', 20);

type DispatchScanJobData = Extract<SecurityScanQueueJobData, { type: 'dispatch-scan' }>;
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
    jobId: stableJobId,
    ...opts,
  });
}

export async function enqueueSecurityScan(scanId: string): Promise<string | null> {
  const job = await addUniqueDispatchJob({ type: 'dispatch-scan', scanId, origin: 'manual' });
  return typeof job.id === 'string' ? job.id : job.id ? String(job.id) : null;
}

async function getOrgRunningScans(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(securityScans)
    .where(and(eq(securityScans.orgId, orgId), eq(securityScans.status, 'running')));
  return Number(row?.count ?? 0);
}

async function getOrgQueuedScans(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(securityScans)
    .where(and(eq(securityScans.orgId, orgId), eq(securityScans.status, 'queued')));
  return Number(row?.count ?? 0);
}

async function getDeviceRunningScans(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(securityScans)
    .where(and(eq(securityScans.deviceId, deviceId), eq(securityScans.status, 'running')));
  return Number(row?.count ?? 0);
}

async function getDevicePendingCommands(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, deviceId),
      eq(deviceCommands.type, CommandTypes.SECURITY_SCAN),
      sql`${deviceCommands.status} in ('pending', 'sent')`,
    ));
  return Number(row?.count ?? 0);
}

async function requeueThrottledScan(data: DispatchScanJobData, reason: string): Promise<void> {
  await addUniqueDispatchJob(data, { delay: SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS * 1000 });
  console.warn(`[SecurityScanJobs] scan ${data.scanId} throttled: ${reason}`);
}

export async function processDispatchScan(data: DispatchScanJobData): Promise<{
  dispatched: boolean;
  commandId: string | null;
}> {
  const [scan] = await db
    .select({
      id: securityScans.id,
      orgId: securityScans.orgId,
      deviceId: securityScans.deviceId,
      scanType: securityScans.scanType,
      status: securityScans.status,
      deviceOrgId: devices.orgId,
    })
    .from(securityScans)
    .innerJoin(devices, eq(devices.id, securityScans.deviceId))
    .where(eq(securityScans.id, data.scanId))
    .limit(1);
  if (!scan || scan.status !== 'queued') return { dispatched: false, commandId: null };

  // The device may have moved org between creation and dispatch. A scan row
  // pointing at a stranger's org is a tenancy defect, not a retryable one.
  if (scan.deviceOrgId !== scan.orgId) {
    await db.update(securityScans)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(securityScans.id, scan.id));
    return { dispatched: false, commandId: null };
  }

  if (await getOrgRunningScans(scan.orgId) >= SECURITY_SCAN_ORG_CONCURRENCY_CAP) {
    await requeueThrottledScan(data, `org cap ${SECURITY_SCAN_ORG_CONCURRENCY_CAP}`);
    return { dispatched: false, commandId: null };
  }
  if (await getDeviceRunningScans(scan.deviceId) >= SECURITY_SCAN_DEVICE_CONCURRENCY_CAP) {
    await requeueThrottledScan(data, `device cap ${SECURITY_SCAN_DEVICE_CONCURRENCY_CAP}`);
    return { dispatched: false, commandId: null };
  }
  if (await getDevicePendingCommands(scan.deviceId) >= SECURITY_SCAN_DEVICE_CONCURRENCY_CAP) {
    await requeueThrottledScan(data, 'device queue busy');
    return { dispatched: false, commandId: null };
  }

  const settings = await resolveSecurityScanSettingsForDevice(scan.deviceId);
  const payload = buildSecurityScanPayload(scan.id, scan.scanType, settings);

  // Claim before dispatching: two workers must never both queue a command.
  const claimed = await db.update(securityScans)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(securityScans.id, scan.id), eq(securityScans.status, 'queued')))
    .returning({ id: securityScans.id });
  if (claimed.length !== 1) return { dispatched: false, commandId: null };

  const queued = await queueCommandForExecution(
    scan.deviceId,
    CommandTypes.SECURITY_SCAN,
    payload,
    { expectedOrgId: scan.orgId },
  );
  if ('error' in queued || !queued.command) {
    await db.update(securityScans)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(securityScans.id, scan.id));
    return { dispatched: false, commandId: null };
  }
  return { dispatched: true, commandId: queued.command.id };
}

/**
 * The ONLY place a security_scan command payload is built. `settings === null`
 * means no policy governs the device: the agent's built-in defaults apply and
 * nothing is auto-quarantined.
 */
export function buildSecurityScanPayload(
  scanRecordId: string,
  scanType: string,
  settings: SecurityScanSettings | null,
  paths?: string[],
): Record<string, unknown> {
  return {
    scanRecordId,
    scanType,
    ...(paths && paths.length > 0 ? { paths } : {}),
    triggerDefender: true,
    ...(settings
      ? {
          exclusions: settings.exclusions,
          maxFileSizeMb: settings.maxFileSizeMb,
          timeoutMinutes: settings.scanTimeoutMinutes,
          autoQuarantine: settings.autoQuarantine,
        }
      : {}),
  };
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
      sql`(${securityScans.status} IN ('queued','running') OR ${securityScans.startedAt} >= ${occurrence})`,
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
    async (job: Job<SecurityScanQueueJobData>) => runWithSystemDbAccess(async () => {
      const data = parseQueueJobData(SECURITY_SCAN_QUEUE, job, securityScanQueueJobDataSchema);
      if (data.type === 'dispatch-scan') {
        assertQueueJobName(SECURITY_SCAN_QUEUE, job, 'dispatch-scan');
        return processDispatchScan(data);
      }
      assertQueueJobName(SECURITY_SCAN_QUEUE, job, 'schedule-policies');
      return processSchedulePolicies(data);
    }),
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
    if (job.name === 'schedule-policies') await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'schedule-policies',
    { type: 'schedule-policies', scanAt: new Date().toISOString() },
    { repeat: { every: POLICY_SCAN_INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } },
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
