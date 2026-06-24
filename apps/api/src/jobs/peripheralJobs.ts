import { Job, Queue, Worker } from 'bullmq';
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { devices, peripheralEvents, peripheralPolicies } from '../db/schema';
import { publishEvent } from '../services/eventBus';
import { CommandTypes, queueCommand, queueCommandForExecution } from '../services/commandQueue';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const PERIPHERAL_ANOMALY_QUEUE = 'peripheral-anomaly-detector';
const PERIPHERAL_POLICY_DISTRIBUTION_QUEUE = 'peripheral-policy-distribution';
const PERIPHERAL_ANOMALY_INTERVAL_MS = 15 * 60 * 1000;
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

type PeripheralJobData = AnomalyScanJobData | PolicyDistributionJobData;

let anomalyQueue: Queue<AnomalyScanJobData> | null = null;
let anomalyWorker: Worker<AnomalyScanJobData> | null = null;
let policyDistributionQueue: Queue<PolicyDistributionJobData> | null = null;
let policyDistributionWorker: Worker<PolicyDistributionJobData> | null = null;

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

export function getPeripheralPolicyDistributionQueue(): Queue<PolicyDistributionJobData> {
  if (!policyDistributionQueue) {
    policyDistributionQueue = new Queue<PolicyDistributionJobData>(PERIPHERAL_POLICY_DISTRIBUTION_QUEUE, {
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
 * worker just read. With no hard-delete path for peripheral policies, a changed
 * id that is absent can only mean the producer's request transaction has not
 * committed yet (the enqueue-before-commit race) — so the worker should retry
 * rather than ship an incomplete policy set. Disabled policies still exist as
 * rows, so they are correctly treated as visible (not a race).
 */
export function findUncommittedPolicyIds(
  changedPolicyIds: string[],
  existingPolicyIds: Iterable<string>
): string[] {
  const existing = new Set(existingPolicyIds);
  return changedPolicyIds.filter((id) => !existing.has(id));
}

export async function processPolicyDistribution(data: PolicyDistributionJobData): Promise<{
  queued: number;
  immediate: number;
  failed: number;
}> {
  // Read the org's full policy set (active AND inactive) plus its devices. The
  // full set lets us both (a) detect the enqueue-before-commit race — a changed
  // policy id missing here means the producer txn hasn't committed yet — and
  // (b) build the payload from the *current* active subset (re-read each run so
  // coalesced bursts always send the latest state).
  const [orgPolicies, orgDevices] = await Promise.all([
    db
      .select()
      .from(peripheralPolicies)
      .where(eq(peripheralPolicies.orgId, data.orgId))
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
    // The producing request transaction hasn't committed yet. Throw so BullMQ
    // retries with backoff; by the next attempt the rows are visible and the
    // re-read above produces the correct payload. Shipping policies:[] here
    // would silently leave agents unenforced.
    throw new Error(
      `peripheral policy distribution raced the producer commit for org ${data.orgId}; `
      + `changed policy id(s) not yet visible: ${uncommitted.join(', ')} — retrying`
    );
  }

  if (orgDevices.length === 0) {
    return { queued: 0, immediate: 0, failed: 0 };
  }

  const activePolicies = orgPolicies.filter((policy) => policy.isActive);

  const payload = {
    generatedAt: new Date().toISOString(),
    reason: data.reason,
    changedPolicyIds: data.changedPolicyIds,
    policies: activePolicies.map((policy) => ({
      id: policy.id,
      name: policy.name,
      deviceClass: policy.deviceClass,
      action: policy.action,
      targetType: policy.targetType,
      targetIds: policy.targetIds ?? {},
      exceptions: policy.exceptions ?? [],
      isActive: policy.isActive,
      updatedAt: policy.updatedAt?.toISOString?.() ?? null
    }))
  };

  let queued = 0;
  let immediate = 0;
  let failed = 0;

  for (const device of orgDevices) {
    try {
      if (device.status === 'online') {
        const result = await queueCommandForExecution(
          device.id,
          CommandTypes.PERIPHERAL_POLICY_SYNC,
          payload,
          { preferHeartbeat: false }
        );
        if (result.command) {
          queued++;
          immediate++;
          continue;
        }
      }

      await queueCommand(device.id, CommandTypes.PERIPHERAL_POLICY_SYNC, payload);
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

function createPeripheralPolicyDistributionWorker(): Worker<PolicyDistributionJobData> {
  return new Worker<PolicyDistributionJobData>(
    PERIPHERAL_POLICY_DISTRIBUTION_QUEUE,
    async (job: Job<PolicyDistributionJobData>) => {
      return runWithSystemDbAccess(async () => {
        return processPolicyDistribution(job.data);
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2
    }
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
        await existing.updateData({
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
      // producer txn commits. Exponential backoff from 250ms covers the brief
      // commit window without delaying healthy distributions.
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
