import { randomUUID } from 'node:crypto';
import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, gt, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { deviceGroupMemberships, devices, organizations, peripheralEvents, peripheralPolicies } from '../db/schema';
import type { PeripheralPolicyTargetIds, PeripheralPolicyTargetType } from '../db/schema/peripheralControl';
import { publishEvent } from '../services/eventBus';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { attachWorkerObservability } from './workerObservability';
import { reconcilePeripheralPolicyDevice } from '../services/peripheralPolicyState';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const PERIPHERAL_ANOMALY_QUEUE = 'peripheral-anomaly-detector';
const PERIPHERAL_POLICY_DISTRIBUTION_QUEUE = 'peripheral-policy-distribution';
const PERIPHERAL_ANOMALY_INTERVAL_MS = 15 * 60 * 1000;
const PERIPHERAL_POLICY_RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000;
const PERIPHERAL_POLICY_RECONCILIATION_PAGE_SIZE = 250;
const DEFAULT_BLOCKED_THRESHOLD = 5;
const ANOMALY_LOOKBACK_MINUTES = 30;

interface AnomalyScanJobData {
  type: 'anomaly-scan';
  queuedAt: string;
}

interface PolicyDistributionJobData {
  type: 'policy-distribution';
  orgId: string;
  changedPolicyIds: string[];
  reason: string;
  queuedAt: string;
}

interface PolicyReconciliationJobData {
  type: 'policy-reconciliation';
  deviceId: string;
  reason: string;
  queuedAt: string;
}

interface PolicyReconciliationSweepJobData {
  type: 'policy-reconciliation-sweep';
  queuedAt: string;
}

type PeripheralPolicyJobData =
  | PolicyDistributionJobData
  | PolicyReconciliationJobData
  | PolicyReconciliationSweepJobData;
type PeripheralJobData = AnomalyScanJobData | PeripheralPolicyJobData;

let anomalyQueue: Queue<AnomalyScanJobData> | null = null;
let anomalyWorker: Worker<AnomalyScanJobData> | null = null;
let policyDistributionQueue: Queue<PeripheralPolicyJobData> | null = null;
let policyDistributionWorker: Worker<PeripheralPolicyJobData> | null = null;

export type PeripheralPolicyTargetSnapshot = {
  orgId: string | null;
  partnerId: string | null;
  targetType: PeripheralPolicyTargetType;
  targetIds: PeripheralPolicyTargetIds | null;
  isActive: boolean;
};

function getBlockedThreshold(): number {
  const raw = process.env.PERIPHERAL_ANOMALY_BLOCKED_THRESHOLD;
  if (!raw) return DEFAULT_BLOCKED_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(
      `[PeripheralJobs] Invalid PERIPHERAL_ANOMALY_BLOCKED_THRESHOLD="${raw}", using default ${DEFAULT_BLOCKED_THRESHOLD}`
    );
    return DEFAULT_BLOCKED_THRESHOLD;
  }
  return parsed;
}

export function getPeripheralAnomalyQueue(): Queue<AnomalyScanJobData> {
  if (!anomalyQueue) {
    anomalyQueue = new Queue<AnomalyScanJobData>(PERIPHERAL_ANOMALY_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return anomalyQueue;
}

export function getPeripheralPolicyDistributionQueue(): Queue<PeripheralPolicyJobData> {
  if (!policyDistributionQueue) {
    policyDistributionQueue = new Queue<PeripheralPolicyJobData>(PERIPHERAL_POLICY_DISTRIBUTION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return policyDistributionQueue;
}

async function processAnomalyScan(_data: AnomalyScanJobData): Promise<{ alerts: number; failed: number }> {
  const threshold = getBlockedThreshold();
  const since = new Date(Date.now() - ANOMALY_LOOKBACK_MINUTES * 60 * 1000);

  const rows = await db
    .select({
      orgId: peripheralEvents.orgId,
      deviceId: peripheralEvents.deviceId,
      blockedCount: sql<number>`count(*)`
    })
    .from(peripheralEvents)
    .where(
      and(
        eq(peripheralEvents.eventType, 'blocked'),
        gte(peripheralEvents.occurredAt, since)
      )
    )
    .groupBy(peripheralEvents.orgId, peripheralEvents.deviceId)
    .having(sql`count(*) >= ${threshold}`);

  if (rows.length === 0) {
    return { alerts: 0, failed: 0 };
  }

  let alerts = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await publishEvent(
        'peripheral.unauthorized_device',
        row.orgId,
        {
          deviceId: row.deviceId,
          blockedCount: Number(row.blockedCount ?? 0),
          threshold,
          lookbackMinutes: ANOMALY_LOOKBACK_MINUTES,
          detectedAt: new Date().toISOString()
        },
        'peripheral-anomaly-worker',
        { priority: 'high' }
      );
      alerts++;
    } catch (error) {
      failed++;
      console.error(
        `[PeripheralJobs] Failed to publish peripheral.unauthorized_device for ${row.deviceId}:`,
        error
      );
    }
  }

  if (failed > 0) {
    console.error(
      `[PeripheralJobs] Anomaly scan: ${failed}/${rows.length} alert publications failed`
    );
  }

  if (failed > 0 && alerts === 0) {
    throw new Error(`All ${failed} anomaly alert publications failed — will retry`);
  }

  return { alerts, failed };
}

/**
 * Returns the changed policy ids that are NOT present in the DB snapshot the
 * worker just read.
 *
 * Individual policies are only ever soft-deleted (isActive=false) — the routes
 * have no per-policy hard-delete, and disabled policies remain rows, so they're
 * "visible" here (not a race). The only hard DELETE is whole-org/partner cascade
 * erasure (services/tenantCascade.ts), which also removes the org's devices, so
 * such a job no-ops at the orgDevices check. Therefore, for a live org within
 * the commit window, an absent changed id means the producer's request
 * transaction hasn't committed yet (the enqueue-before-commit race) and the
 * worker should retry rather than ship an incomplete policy set. On the final
 * attempt the caller stops retrying and distributes the current active set —
 * see processPolicyDistribution's `isFinalAttempt` handling.
 */
export function findUncommittedPolicyIds(
  changedPolicyIds: string[],
  existingPolicyIds: Iterable<string>
): string[] {
  const existing = new Set(existingPolicyIds);
  return changedPolicyIds.filter((id) => !existing.has(id));
}

export async function processPolicyDistribution(
  data: PolicyDistributionJobData,
  options: {
    isFinalAttempt?: boolean;
    scheduleDevice?: (deviceId: string, reason: string) => Promise<string>;
  } = {}
): Promise<{
  queued: number;
  immediate: number;
  failed: number;
}> {
  // Read the org's full policy set (active AND inactive) plus its devices. The
  // full set lets us both (a) detect the enqueue-before-commit race — a changed
  // policy id missing here means the producer txn hasn't committed yet — and
  // (b) build the payload from the *current* active subset (re-read each run so
  // coalesced bursts always send the latest state).
  // The org's applicable policy set is dual-axis (#2131): its own org-owned
  // rows PLUS partner-wide rows (org_id NULL) owned by the org's partner —
  // the worker runs under system context, so both axes are visible.
  const [orgRow] = await db
    .select({ partnerId: organizations.partnerId, type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, data.orgId))
    .limit(1);

  // Quick Support exclusion: the hidden per-partner 'quick_support' org holds
  // ephemeral devices — a stranger's personal machine borrowed for one
  // ~20-minute session. It stays inside technicians' accessibleOrgIds for RLS
  // reasons, so the partner-wide (org_id NULL) policy branch below would
  // otherwise push the MSP's USB/peripheral-blocking policy onto a home PC.
  // Bail on the org, and belt-and-braces exclude ephemeral devices from the
  // device sweep so a stray org-owned policy cannot reach them either.
  if (orgRow?.type === 'quick_support') {
    return { queued: 0, immediate: 0, failed: 0 };
  }

  const policyOwnershipCondition = orgRow?.partnerId
    ? or(
        eq(peripheralPolicies.orgId, data.orgId),
        and(isNull(peripheralPolicies.orgId), eq(peripheralPolicies.partnerId, orgRow.partnerId))
      )
    : eq(peripheralPolicies.orgId, data.orgId);

  const [orgPolicies, orgDevices] = await Promise.all([
    db
      .select()
      .from(peripheralPolicies)
      .where(policyOwnershipCondition)
      .orderBy(peripheralPolicies.updatedAt),
    db
      .select({
        id: devices.id,
        status: devices.status
      })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, data.orgId),
          eq(devices.isEphemeral, false),
          ne(devices.status, 'decommissioned')
        )
      )
  ]);

  const changedPolicyIds = data.changedPolicyIds ?? [];
  const uncommitted = findUncommittedPolicyIds(
    changedPolicyIds,
    orgPolicies.map((policy) => policy.id)
  );
  if (uncommitted.length > 0) {
    if (!options.isFinalAttempt) {
      // The producing request transaction hasn't committed yet. Throw so BullMQ
      // retries with backoff; by the next attempt the rows are visible and the
      // re-read above produces the correct payload. Shipping policies:[] here
      // would silently leave agents unenforced.
      throw new Error(
        `peripheral policy distribution raced the producer commit for org ${data.orgId}; `
        + `changed policy id(s) not yet visible: ${uncommitted.join(', ')} — retrying`
      );
    }
    // Final attempt: the changed ids never became visible across all retries.
    // This is no longer a commit race (a normal txn commits in well under the
    // retry budget) — the policies were rolled back or hard-deleted (e.g. org
    // cascade). Don't throw into a silent terminal failure; distribute the
    // CURRENT active set, which correctly excludes the vanished ids.
    console.warn(
      `[PeripheralJobs] org ${data.orgId}: changed policy id(s) ${uncommitted.join(', ')} still not `
      + `visible after final attempt — treating as rolled-back/deleted and distributing current active set`
    );
  }

  if (orgDevices.length === 0) {
    console.log(
      `[PeripheralJobs] org ${data.orgId} has no eligible devices; nothing to distribute`
    );
    return { queued: 0, immediate: 0, failed: 0 };
  }

  let queued = 0;
  let immediate = 0;
  let failed = 0;
  const scheduleDevice = options.scheduleDevice ?? schedulePeripheralPolicyDevice;

  for (const device of orgDevices) {
    try {
      await scheduleDevice(device.id, data.reason);
      queued++;
    } catch (error) {
      failed++;
      console.error(
        `[PeripheralJobs] Failed to queue peripheral policy sync for device ${device.id}:`,
        error
      );
    }
  }

  if (failed > 0) {
    console.error(
      `[PeripheralJobs] Policy distribution for org ${data.orgId}: ${failed}/${orgDevices.length} devices failed`
    );
  }

  // If EVERY device enqueue failed we built a correct payload and then dropped
  // it — throw so BullMQ retries rather than reporting a successful no-op (mirrors
  // processAnomalyScan's all-failed guard). Policy sync is idempotent, so the
  // retry safely re-enqueues the devices that may have already succeeded.
  if (orgDevices.length > 0 && failed === orgDevices.length) {
    throw new Error(
      `peripheral policy distribution: all ${failed} device enqueue(s) failed for org ${data.orgId} — retrying`
    );
  }

  return { queued, immediate, failed };
}

function createPeripheralAnomalyWorker(): Worker<AnomalyScanJobData> {
  return new Worker<AnomalyScanJobData>(
    PERIPHERAL_ANOMALY_QUEUE,
    async (job: Job<AnomalyScanJobData>) => {
      return runWithSystemDbAccess(async () => {
        return processAnomalyScan(job.data);
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

function createPeripheralPolicyDistributionWorker(): Worker<PeripheralPolicyJobData> {
  return new Worker<PeripheralPolicyJobData>(
    PERIPHERAL_POLICY_DISTRIBUTION_QUEUE,
    async (job: Job<PeripheralPolicyJobData>) => {
      const data = job.data;
      if (data.type === 'policy-reconciliation') {
        return runWithSystemDbAccess(() =>
          reconcilePeripheralPolicyDevice(data.deviceId, data.reason));
      }
      if (data.type === 'policy-reconciliation-sweep') {
        return processPeripheralPolicyReconciliationSweep();
      }
      // attemptsMade counts prior failures, so this run is attempt
      // (attemptsMade + 1); on the last one we stop retrying the commit-race and
      // distribute the current active set instead of failing silently.
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
      return runWithSystemDbAccess(async () => {
        return processPolicyDistribution(data, { isFinalAttempt });
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2
    }
  );
}

export async function schedulePeripheralPolicyDevice(
  deviceId: string,
  reason: string,
): Promise<string> {
  const queue = getPeripheralPolicyDistributionQueue();
  const jobId = `policy-reconciliation-${deviceId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      if (state === 'active') {
        const followUp = await queue.add(
          'policy-reconciliation',
          {
            type: 'policy-reconciliation',
            deviceId,
            reason,
            queuedAt: new Date().toISOString(),
          },
          {
            jobId: `${jobId}-follow-up-${randomUUID()}`,
            attempts: 6,
            backoff: { type: 'exponential', delay: 250 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 200 },
          },
        );
        return String(followUp.id);
      }
      if (existing.data.type === 'policy-reconciliation') {
        await (existing as Job<PolicyReconciliationJobData>).updateData({
          ...existing.data,
          reason,
          queuedAt: new Date().toISOString(),
        });
      }
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[PeripheralJobs] Failed to remove stale reconciliation job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'policy-reconciliation',
    {
      type: 'policy-reconciliation',
      deviceId,
      reason,
      queuedAt: new Date().toISOString(),
    },
    {
      jobId,
      attempts: 6,
      backoff: { type: 'exponential', delay: 250 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  );
  return String(job.id);
}

export async function resolvePeripheralPolicyDeviceIds(
  policy: PeripheralPolicyTargetSnapshot,
): Promise<string[]> {
  if (!policy.isActive) return [];

  const orgIds = policy.orgId
    ? [policy.orgId]
    : policy.partnerId
      ? (await db.select({ id: organizations.id })
        .from(organizations)
        .where(and(
          eq(organizations.partnerId, policy.partnerId),
          ne(organizations.type, 'quick_support'),
        ))).map(({ id }) => id)
      : [];
  if (orgIds.length === 0) return [];

  const targets = policy.targetIds ?? {};
  const conditions = [
    inArray(devices.orgId, orgIds),
    eq(devices.isEphemeral, false),
  ];

  if (policy.targetType === 'site') {
    const siteIds = targets.siteIds ?? [];
    if (siteIds.length === 0) return [];
    conditions.push(inArray(devices.siteId, siteIds));
  } else if (policy.targetType === 'device') {
    const deviceIds = targets.deviceIds ?? [];
    if (deviceIds.length === 0) return [];
    conditions.push(inArray(devices.id, deviceIds));
  } else if (policy.targetType === 'group') {
    const groupIds = targets.groupIds ?? [];
    if (groupIds.length === 0) return [];
    const rows = await db.select({ id: devices.id })
      .from(devices)
      .innerJoin(deviceGroupMemberships, eq(deviceGroupMemberships.deviceId, devices.id))
      .where(and(...conditions, inArray(deviceGroupMemberships.groupId, groupIds)));
    return [...new Set(rows.map(({ id }) => id))].sort();
  }

  const rows = await db.select({ id: devices.id })
    .from(devices)
    .where(and(...conditions));
  return [...new Set(rows.map(({ id }) => id))].sort();
}

export async function schedulePeripheralPolicyDevices(
  deviceIds: readonly string[],
  reason: string,
): Promise<string[]> {
  return Promise.all([...new Set(deviceIds)].sort().map((deviceId) =>
    schedulePeripheralPolicyDevice(deviceId, reason)
  ));
}

type ReconciliationSweepOptions = {
  pageSize?: number;
  loadPage?: (afterId: string | null, limit: number) => Promise<Array<{ id: string }>>;
  reconcile?: typeof reconcilePeripheralPolicyDevice;
};

export async function processPeripheralPolicyReconciliationSweep(
  options: ReconciliationSweepOptions = {},
): Promise<{ scanned: number; queued: number; coalesced: number; incompatible: number }> {
  const pageSize = options.pageSize ?? PERIPHERAL_POLICY_RECONCILIATION_PAGE_SIZE;
  const loadPage = options.loadPage ?? ((afterId, limit) => runWithSystemDbAccess(() => db
    .select({ id: devices.id })
    .from(devices)
    .where(and(
      eq(devices.isEphemeral, false),
      eq(devices.peripheralPolicyProtocolVersion, 2),
      ...(afterId ? [gt(devices.id, afterId)] : []),
    ))
    .orderBy(asc(devices.id))
    .limit(limit)));
  const reconcile = options.reconcile ?? reconcilePeripheralPolicyDevice;
  const counts = { scanned: 0, queued: 0, coalesced: 0, incompatible: 0 };
  let afterId: string | null = null;

  while (true) {
    const page = await loadPage(afterId, pageSize);
    for (const { id } of page) {
      const outcome = await reconcile(id, 'periodic_drift');
      counts.scanned += 1;
      counts[outcome] += 1;
    }
    if (page.length < pageSize) break;
    afterId = page[page.length - 1]?.id ?? null;
    if (!afterId) break;
  }

  return counts;
}

export async function schedulePeripheralPolicyReconciliationSweep(
  random: () => number = Math.random,
): Promise<void> {
  const queue = getPeripheralPolicyDistributionQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'policy-reconciliation-sweep') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'policy-reconciliation-sweep',
    { type: 'policy-reconciliation-sweep', queuedAt: new Date().toISOString() },
    {
      jobId: 'policy-reconciliation-sweep',
      repeat: { every: PERIPHERAL_POLICY_RECONCILIATION_INTERVAL_MS },
      delay: Math.floor(random() * PERIPHERAL_POLICY_RECONCILIATION_INTERVAL_MS),
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    },
  );
}

async function scheduleAnomalyScan(): Promise<void> {
  const queue = getPeripheralAnomalyQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'anomaly-scan') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'anomaly-scan',
    {
      type: 'anomaly-scan',
      queuedAt: new Date().toISOString()
    },
    {
      repeat: { every: PERIPHERAL_ANOMALY_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 }
    }
  );
}

export async function schedulePeripheralPolicyDistribution(
  orgId: string,
  policyIds: string[] = [],
  reason: string = 'manual'
): Promise<string> {
  const queue = getPeripheralPolicyDistributionQueue();
  const jobId = `policy-distribution-${orgId}`;
  const normalizedPolicyIds = Array.from(new Set(policyIds.filter((id) => typeof id === 'string' && id.length > 0)));

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      const existingData = existing.data;
      if (existingData.type === 'policy-distribution') {
        const mergedPolicyIds = Array.from(
          new Set([...(existingData.changedPolicyIds ?? []), ...normalizedPolicyIds])
        );
        await (existing as Job<PolicyDistributionJobData>).updateData({
          ...existingData,
          changedPolicyIds: mergedPolicyIds,
          reason,
          queuedAt: new Date().toISOString(),
        });
      }
      return String(existing.id);
    }

    await existing.remove().catch((error) => {
      console.error(
        `[PeripheralJobs] Failed to remove stale policy distribution job ${jobId} — queue infrastructure may be degraded:`,
        error
      );
    });
  }

  const job = await queue.add(
    'policy-distribution',
    {
      type: 'policy-distribution',
      orgId,
      changedPolicyIds: normalizedPolicyIds,
      reason,
      queuedAt: new Date().toISOString(),
    },
    {
      jobId,
      // Retry so a run that loses the enqueue-before-commit race (changed policy
      // not yet visible → processPolicyDistribution throws) re-runs after the
      // producer txn commits. Healthy (non-raced) runs succeed on attempt 1 with
      // no added delay. Exponential backoff is ~250ms, 500ms, 1s, 2s, 4s — the
      // first attempts cover the normal sub-second commit window; the rest are
      // headroom. On the final attempt the worker degrades instead of failing
      // (distributes the current active set) — see processPolicyDistribution.
      attempts: 6,
      backoff: { type: 'exponential', delay: 250 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );

  return String(job.id);
}

export async function initializePeripheralJobs(): Promise<void> {
  anomalyWorker = createPeripheralAnomalyWorker();
  attachWorkerObservability(anomalyWorker, 'peripheralAnomalyWorker');
  policyDistributionWorker = createPeripheralPolicyDistributionWorker();
  attachWorkerObservability(policyDistributionWorker, 'peripheralPolicyDistributionWorker');

  anomalyWorker.on('error', (error) => {
    console.error('[PeripheralJobs] Anomaly worker error:', error);
  });
  anomalyWorker.on('failed', (job, error) => {
    console.error(`[PeripheralJobs] Anomaly job ${job?.id} failed:`, error);
  });

  policyDistributionWorker.on('error', (error) => {
    console.error('[PeripheralJobs] Policy distribution worker error:', error);
  });
  policyDistributionWorker.on('failed', (job, error) => {
    console.error(`[PeripheralJobs] Policy distribution job ${job?.id} failed:`, error);
  });

  await scheduleAnomalyScan();
  await schedulePeripheralPolicyReconciliationSweep();
  console.log('[PeripheralJobs] Peripheral anomaly + policy distribution workers initialized');
}

export async function shutdownPeripheralJobs(): Promise<void> {
  if (anomalyWorker) {
    await anomalyWorker.close();
    anomalyWorker = null;
  }
  if (policyDistributionWorker) {
    await policyDistributionWorker.close();
    policyDistributionWorker = null;
  }
  if (anomalyQueue) {
    await anomalyQueue.close();
    anomalyQueue = null;
  }
  if (policyDistributionQueue) {
    await policyDistributionQueue.close();
    policyDistributionQueue = null;
  }
}
