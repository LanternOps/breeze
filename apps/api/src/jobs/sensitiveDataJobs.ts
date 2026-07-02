import { Job, Queue, Worker, type JobsOptions } from 'bullmq';
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';

import * as dbModule from '../db';
import { deviceCommands, devices, organizations, sensitiveDataPolicies, sensitiveDataScans } from '../db/schema';
import { CommandTypes, queueCommandForExecution } from '../services/commandQueue';
import { isCronDue } from '../services/automationRuntime';
import { attachWorkerObservability } from './workerObservability';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { sensitiveDataQueueJobDataSchema, type SensitiveDataQueueJobData } from './queueSchemas';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SENSITIVE_DATA_QUEUE = 'sensitive-data';
const POLICY_SCAN_INTERVAL_MS = 60 * 1000;

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

const SENSITIVE_DATA_WORKER_CONCURRENCY = parsePositiveIntEnv('SENSITIVE_DATA_WORKER_CONCURRENCY', 6);
const SENSITIVE_DATA_ORG_CONCURRENCY_CAP = parsePositiveIntEnv('SENSITIVE_DATA_ORG_CONCURRENCY_CAP', 40);
const SENSITIVE_DATA_DEVICE_CONCURRENCY_CAP = parsePositiveIntEnv('SENSITIVE_DATA_DEVICE_CONCURRENCY_CAP', 1);
const SENSITIVE_DATA_ORG_QUEUE_BACKPRESSURE_LIMIT = parsePositiveIntEnv('SENSITIVE_DATA_ORG_QUEUE_BACKPRESSURE_LIMIT', 500);
const SENSITIVE_DATA_THROTTLE_REQUEUE_SECONDS = parsePositiveIntEnv('SENSITIVE_DATA_THROTTLE_REQUEUE_SECONDS', 20);

// Per-variant types are derived from the Zod union validated at the dequeue
// boundary so they can never drift from the schema (see queueSchemas.ts).
type DispatchScanJobData = Extract<SensitiveDataQueueJobData, { type: 'dispatch-scan' }>;
type SchedulePoliciesJobData = Extract<SensitiveDataQueueJobData, { type: 'schedule-policies' }>;

type SensitiveDataJobData = SensitiveDataQueueJobData;

let sensitiveDataQueue: Queue<SensitiveDataJobData> | null = null;
let sensitiveDataWorker: Worker<SensitiveDataJobData> | null = null;

function getSensitiveDataDispatchJobId(scanId: string): string {
  return `sensitive-scan-${scanId}`;
}

export function getSensitiveDataQueue(): Queue<SensitiveDataJobData> {
  if (!sensitiveDataQueue) {
    sensitiveDataQueue = new Queue<SensitiveDataJobData>(SENSITIVE_DATA_QUEUE, {
      connection: getBullMQConnection()
    });
  }
  return sensitiveDataQueue;
}

async function addUniqueSensitiveDataDispatchJob(
  scanId: string,
  opts: Omit<JobsOptions, 'jobId'> = {},
) {
  const queue = getSensitiveDataQueue();
  const stableJobId = getSensitiveDataDispatchJobId(scanId);
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing;
    }
    await existing.remove().catch((error) => {
      console.error(`[SensitiveDataJobs] Failed to remove stale job:`, error);
    });
  }

  return queue.add(
    'dispatch-scan',
    { type: 'dispatch-scan', scanId },
    {
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      jobId: stableJobId,
      ...opts,
    }
  );
}

export async function enqueueSensitiveDataScan(scanId: string): Promise<string | null> {
  const job = await addUniqueSensitiveDataDispatchJob(scanId);
  return typeof job.id === 'string' ? job.id : job.id ? String(job.id) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDetectionClasses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

function parsePolicySchedule(raw: unknown): {
  enabled: boolean;
  type: 'manual' | 'interval' | 'cron';
  intervalMinutes: number;
  cron: string | null;
  timezone: string;
  deviceIds: string[];
  lastRunAt: string | null;
} {
  if (!isRecord(raw)) {
    return {
      enabled: false,
      type: 'manual',
      intervalMinutes: 0,
      cron: null,
      timezone: 'UTC',
      deviceIds: [],
      lastRunAt: null
    };
  }

  const typeRaw = typeof raw.type === 'string' ? raw.type : 'manual';
  const type = typeRaw === 'interval' || typeRaw === 'cron' ? typeRaw : 'manual';
  const intervalMinutes = typeof raw.intervalMinutes === 'number'
    ? Math.max(5, Math.min(7 * 24 * 60, Math.floor(raw.intervalMinutes)))
    : 60;
  const cron = typeof raw.cron === 'string' && raw.cron.trim().length > 0 ? raw.cron.trim() : null;
  const timezone = typeof raw.timezone === 'string' && raw.timezone.trim().length > 0
    ? raw.timezone.trim()
    : 'UTC';
  const deviceIds = Array.isArray(raw.deviceIds)
    ? raw.deviceIds.filter((value): value is string => typeof value === 'string')
    : [];
  const lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null;

  return {
    enabled: raw.enabled !== false,
    type,
    intervalMinutes,
    cron,
    timezone,
    deviceIds,
    lastRunAt
  };
}

function sameMinute(left: Date, right: Date): boolean {
  return left.getUTCFullYear() === right.getUTCFullYear()
    && left.getUTCMonth() === right.getUTCMonth()
    && left.getUTCDate() === right.getUTCDate()
    && left.getUTCHours() === right.getUTCHours()
    && left.getUTCMinutes() === right.getUTCMinutes();
}

export function shouldSchedulePolicy(rawSchedule: unknown, now: Date): boolean {
  const schedule = parsePolicySchedule(rawSchedule);
  if (!schedule.enabled) return false;
  if (schedule.type === 'manual') return false;

  const lastRun = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
  const hasLastRun = Boolean(lastRun) && Number.isFinite(lastRun?.getTime());

  if (schedule.type === 'interval') {
    if (!hasLastRun) return true;
    const elapsed = now.getTime() - (lastRun as Date).getTime();
    return elapsed >= schedule.intervalMinutes * 60 * 1000;
  }

  if (!schedule.cron) return false;
  if (hasLastRun && sameMinute(lastRun as Date, now)) return false;
  return isCronDue(schedule.cron, schedule.timezone, now);
}

async function getOrgRunningScans(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sensitiveDataScans)
    .where(and(
      eq(sensitiveDataScans.orgId, orgId),
      eq(sensitiveDataScans.status, 'running')
    ));
  return Number(row?.count ?? 0);
}

async function getOrgQueuedScans(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sensitiveDataScans)
    .where(and(
      eq(sensitiveDataScans.orgId, orgId),
      eq(sensitiveDataScans.status, 'queued')
    ));
  return Number(row?.count ?? 0);
}

async function getDeviceRunningScans(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sensitiveDataScans)
    .where(and(
      eq(sensitiveDataScans.deviceId, deviceId),
      eq(sensitiveDataScans.status, 'running')
    ));
  return Number(row?.count ?? 0);
}

async function getDevicePendingCommands(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, deviceId),
      eq(deviceCommands.type, CommandTypes.SENSITIVE_DATA_SCAN),
      sql`${deviceCommands.status} in ('pending', 'sent')`
    ));
  return Number(row?.count ?? 0);
}

async function requeueThrottledScan(scanId: string, reason: string): Promise<void> {
  await addUniqueSensitiveDataDispatchJob(scanId, {
    delay: SENSITIVE_DATA_THROTTLE_REQUEUE_SECONDS * 1000,
  });
  await db
    .update(sensitiveDataScans)
    .set({
      summary: {
        throttled: true,
        reason,
        requeuedAt: new Date().toISOString(),
      }
    })
    .where(eq(sensitiveDataScans.id, scanId));
}

async function processDispatchScan(data: DispatchScanJobData): Promise<{
  dispatched: boolean;
  commandId: string | null;
}> {
  const [scan] = await db
    .select({
      id: sensitiveDataScans.id,
      orgId: sensitiveDataScans.orgId,
      deviceId: sensitiveDataScans.deviceId,
      policyId: sensitiveDataScans.policyId,
      requestedBy: sensitiveDataScans.requestedBy,
      status: sensitiveDataScans.status,
      startedAt: sensitiveDataScans.startedAt,
      summary: sensitiveDataScans.summary,
      policyScope: sensitiveDataPolicies.scope,
      policyClasses: sensitiveDataPolicies.detectionClasses
    })
    .from(sensitiveDataScans)
    .leftJoin(sensitiveDataPolicies, eq(sensitiveDataPolicies.id, sensitiveDataScans.policyId))
    .where(eq(sensitiveDataScans.id, data.scanId))
    .limit(1);

  if (!scan) return { dispatched: false, commandId: null };
  if (scan.status !== 'queued' && scan.status !== 'running') {
    return { dispatched: false, commandId: null };
  }

  const orgRunning = await getOrgRunningScans(scan.orgId);
  if (orgRunning >= SENSITIVE_DATA_ORG_CONCURRENCY_CAP) {
    await requeueThrottledScan(scan.id, `org cap ${SENSITIVE_DATA_ORG_CONCURRENCY_CAP}`);
    return { dispatched: false, commandId: null };
  }

  const deviceRunning = await getDeviceRunningScans(scan.deviceId);
  if (deviceRunning >= SENSITIVE_DATA_DEVICE_CONCURRENCY_CAP) {
    await requeueThrottledScan(scan.id, `device cap ${SENSITIVE_DATA_DEVICE_CONCURRENCY_CAP}`);
    return { dispatched: false, commandId: null };
  }

  const pendingCommands = await getDevicePendingCommands(scan.deviceId);
  if (pendingCommands >= SENSITIVE_DATA_DEVICE_CONCURRENCY_CAP) {
    await requeueThrottledScan(scan.id, 'device queue busy');
    return { dispatched: false, commandId: null };
  }

  const summary = isRecord(scan.summary) ? scan.summary : {};
  const request = isRecord(summary.request) ? summary.request : {};
  const scope = isRecord(request.scope)
    ? request.scope
    : (isRecord(scan.policyScope) ? scan.policyScope : {});

  const detectionClasses = parseDetectionClasses(request.detectionClasses);
  const fallbackClasses = parseDetectionClasses(scan.policyClasses);
  const resolvedClasses = detectionClasses.length > 0
    ? detectionClasses
    : (fallbackClasses.length > 0 ? fallbackClasses : ['credential']);

  const commandPayload = {
    scanId: scan.id,
    policyId: scan.policyId,
    scope,
    detectionClasses: resolvedClasses,
  };

  await db
    .update(sensitiveDataScans)
    .set({
      status: 'running',
      startedAt: scan.startedAt ?? new Date(),
      summary: {
        ...summary,
        dispatch: {
          ...(isRecord(summary.dispatch) ? summary.dispatch : {}),
          requestedAt: new Date().toISOString()
        }
      }
    })
    .where(eq(sensitiveDataScans.id, scan.id));

  const queued = await queueCommandForExecution(
    scan.deviceId,
    CommandTypes.SENSITIVE_DATA_SCAN,
    commandPayload,
    {
      userId: scan.requestedBy ?? undefined,
      preferHeartbeat: false
    }
  );

  if (!queued.command) {
    await db
      .update(sensitiveDataScans)
      .set({
        status: 'failed',
        completedAt: new Date(),
        summary: {
          ...summary,
          dispatch: {
            ...(isRecord(summary.dispatch) ? summary.dispatch : {}),
            failedAt: new Date().toISOString(),
            error: queued.error ?? 'Failed to dispatch command to device'
          }
        }
      })
      .where(eq(sensitiveDataScans.id, scan.id));
    return { dispatched: false, commandId: null };
  }

  await db
    .update(sensitiveDataScans)
    .set({
      summary: {
        ...summary,
        dispatch: {
          ...(isRecord(summary.dispatch) ? summary.dispatch : {}),
          commandId: queued.command.id,
          commandStatus: queued.command.status,
          dispatchedAt: new Date().toISOString()
        }
      }
    })
    .where(eq(sensitiveDataScans.id, scan.id));

  return {
    dispatched: true,
    commandId: queued.command.id
  };
}

type SchedulablePolicy = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  scope: unknown;
  detectionClasses: unknown;
  schedule: unknown;
};

/**
 * Queue scheduled scans for ONE due policy. Exported so the integration suite
 * can prove the partner-wide device fan-out against real Postgres without
 * sweeping every active policy in the shared test DB.
 */
export async function schedulePolicyScans(policy: SchedulablePolicy, now: Date): Promise<number> {
  // Resolve the policy owner's device-org pool (#2131): an org-owned policy
  // targets its own org; a partner-wide policy (orgId NULL) fans out to
  // every org under the owning partner. The per-org queue backpressure
  // check runs per member org so one saturated org doesn't starve the rest.
  let ownerOrgIds: string[];
  if (policy.orgId) {
    ownerOrgIds = [policy.orgId];
  } else if (policy.partnerId) {
    const orgRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, policy.partnerId));
    ownerOrgIds = orgRows.map((row) => row.id);
  } else {
    ownerOrgIds = [];
  }

  const admittedOrgIds: string[] = [];
  for (const orgId of ownerOrgIds) {
    const orgQueued = await getOrgQueuedScans(orgId);
    if (orgQueued < SENSITIVE_DATA_ORG_QUEUE_BACKPRESSURE_LIMIT) {
      admittedOrgIds.push(orgId);
    }
  }
  if (admittedOrgIds.length === 0) return 0;

  const schedule = parsePolicySchedule(policy.schedule);
  const conditions: SQL[] = [
    inArray(devices.orgId, admittedOrgIds),
    ne(devices.status, 'decommissioned')
  ];
  if (schedule.deviceIds.length > 0) {
    conditions.push(inArray(devices.id, schedule.deviceIds));
  }

  const targetDevices = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(and(...conditions));

  if (targetDevices.length === 0) return 0;

  const created = await db
    .insert(sensitiveDataScans)
    .values(
      targetDevices.map((device) => ({
        // Scan rows always take the DEVICE's org — identical to the
        // policy's org for org-owned policies, and the only correct org
        // for partner-wide ones.
        orgId: device.orgId,
        deviceId: device.id,
        policyId: policy.id,
        status: 'queued',
        summary: {
          source: 'policy_scheduler',
          policySchedule: {
            type: schedule.type,
            cron: schedule.cron,
            intervalMinutes: schedule.intervalMinutes
          },
          request: {
            scope: isRecord(policy.scope) ? policy.scope : {},
            detectionClasses: parseDetectionClasses(policy.detectionClasses)
          }
        }
      }))
    )
    .returning({ id: sensitiveDataScans.id });

  if (created.length > 0) {
    const queue = getSensitiveDataQueue();
    await queue.addBulk(
      created.map((scan) => ({
        name: 'dispatch-scan',
        data: { type: 'dispatch-scan' as const, scanId: scan.id },
        opts: {
          jobId: `sensitive-scan-${scan.id}`,
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 }
        }
      }))
    );
  }

  await db
    .update(sensitiveDataPolicies)
    .set({
      schedule: {
        ...(isRecord(policy.schedule) ? policy.schedule : {}),
        lastRunAt: now.toISOString()
      },
      updatedAt: new Date()
    })
    .where(eq(sensitiveDataPolicies.id, policy.id));

  return created.length;
}

async function processSchedulePolicies(data: SchedulePoliciesJobData): Promise<{
  scheduledPolicies: number;
  scansQueued: number;
}> {
  const parsedScanAt = new Date(data.scanAt);
  const now = Number.isFinite(parsedScanAt.getTime()) ? parsedScanAt : new Date();

  const policies = await db
    .select({
      id: sensitiveDataPolicies.id,
      orgId: sensitiveDataPolicies.orgId,
      partnerId: sensitiveDataPolicies.partnerId,
      scope: sensitiveDataPolicies.scope,
      detectionClasses: sensitiveDataPolicies.detectionClasses,
      schedule: sensitiveDataPolicies.schedule
    })
    .from(sensitiveDataPolicies)
    .where(eq(sensitiveDataPolicies.isActive, true));

  if (policies.length === 0) return { scheduledPolicies: 0, scansQueued: 0 };

  let scheduledPolicies = 0;
  let scansQueued = 0;

  for (const policy of policies) {
    if (!shouldSchedulePolicy(policy.schedule, now)) continue;

    const queued = await schedulePolicyScans(policy, now);
    if (queued > 0) {
      scansQueued += queued;
      scheduledPolicies++;
    }
  }

  return { scheduledPolicies, scansQueued };
}

export function createSensitiveDataWorker(): Worker<SensitiveDataJobData> {
  return new Worker<SensitiveDataJobData>(
    SENSITIVE_DATA_QUEUE,
    async (job: Job<SensitiveDataJobData>) => {
      return runWithSystemDbAccess(async () => {
        const data = parseQueueJobData(SENSITIVE_DATA_QUEUE, job, sensitiveDataQueueJobDataSchema);
        if (data.type === 'dispatch-scan') {
          assertQueueJobName(SENSITIVE_DATA_QUEUE, job, 'dispatch-scan');
          return processDispatchScan(data);
        }
        assertQueueJobName(SENSITIVE_DATA_QUEUE, job, 'schedule-policies');
        return processSchedulePolicies(data);
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: SENSITIVE_DATA_WORKER_CONCURRENCY,
      lockDuration: 120_000,
      lockRenewTime: 60_000,
    }
  );
}

async function schedulePolicyWorker(): Promise<void> {
  const queue = getSensitiveDataQueue();
  const repeatable = await queue.getRepeatableJobs();
  for (const job of repeatable) {
    if (job.name === 'schedule-policies') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'schedule-policies',
    { type: 'schedule-policies', scanAt: new Date().toISOString() },
    {
      repeat: { every: POLICY_SCAN_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 100 }
    }
  );
}

export async function initializeSensitiveDataWorkers(): Promise<void> {
  sensitiveDataWorker = createSensitiveDataWorker();
  attachWorkerObservability(sensitiveDataWorker, 'sensitiveDataWorker');
  sensitiveDataWorker.on('error', (error) => {
    console.error('[SensitiveDataWorker] Worker error:', error);
  });
  sensitiveDataWorker.on('failed', (job, error) => {
    console.error(`[SensitiveDataWorker] Job ${job?.id} failed:`, error);
  });

  await schedulePolicyWorker();
  console.log('[SensitiveDataWorker] Sensitive data workers initialized');
}

export async function shutdownSensitiveDataWorkers(): Promise<void> {
  if (sensitiveDataWorker) {
    await sensitiveDataWorker.close();
    sensitiveDataWorker = null;
  }
  if (sensitiveDataQueue) {
    await sensitiveDataQueue.close();
    sensitiveDataQueue = null;
  }
}
