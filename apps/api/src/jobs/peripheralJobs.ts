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
  options: { isFinalAttempt?: boolean } = {}
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

  const activePolicies = orgPolicies.filter((policy) => policy.isActive);

  const payload = {
    generatedAt: new Date().toISOString(),
    reason: data.reason,
    changedPolicyIds,
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

function createPeripheralPolicyDistributionWorker(): Worker<PolicyDistributionJobData> {
  return new Worker<PolicyDistributionJobData>(
    PERIPHERAL_POLICY_DISTRIBUTION_QUEUE,
    async (job: Job<PolicyDistributionJobData>) => {
      // attemptsMade counts prior failures, so this run is attempt
      // (attemptsMade + 1); on the last one we stop retrying the commit-race and
      // distribute the current active set instead of failing silently.
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
      return runWithSystemDbAccess(async () => {
        return processPolicyDistribution(job.data, { isFinalAttempt });
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
