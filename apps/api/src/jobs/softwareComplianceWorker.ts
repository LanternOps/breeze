import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import * as dbModule from '../db';
import { softwareComplianceStatus, softwarePolicies } from '../db/schema';
import {
  recordSoftwarePolicyEvaluation,
  recordSoftwarePolicyViolation,
  recordSoftwareRemediationDecision,
} from '../routes/metrics';
import { getRedisConnection } from '../services/redis';
import {
  evaluateSoftwarePolicyAgainstInventory,
  getSoftwareInventoryByDeviceIds,
  normalizeSoftwarePolicyRules,
  recordSoftwarePolicyAudit,
  resolveEffectivePolicyDeviceIds,
  resolveTargetDeviceIdsForPolicy,
  upsertSoftwareComplianceStatuses,
  withStableViolationTimestamps,
  type SoftwarePolicyComplianceStatus,
  type SoftwarePolicyRemediationStatus,
} from '../services/softwarePolicyService';
import { scheduleSoftwareRemediation } from './softwareRemediationWorker';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    console.error('[SoftwareComplianceWorker] withSystemDbAccessContext is not available — running without access context');
  }
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function fireAudit(input: Parameters<typeof recordSoftwarePolicyAudit>[0]): void {
  recordSoftwarePolicyAudit(input).catch((err) => {
    console.error('[SoftwareComplianceWorker] Audit write failed:', err);
  });
}

const SOFTWARE_COMPLIANCE_QUEUE = 'software-compliance';
const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const REMEDIATION_COOLDOWN_DEFAULT_MINUTES = 120;
const QUERY_CHUNK_SIZE = 500;
const ON_DEMAND_DEDUPE_WINDOW_MS = 30 * 1000;

function chunkArray<T>(items: T[], size = QUERY_CHUNK_SIZE): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function stableShortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

type ExistingComplianceState = {
  deviceId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: unknown;
  remediationStatus: SoftwarePolicyRemediationStatus | null;
  lastRemediationAttempt: Date | null;
};

async function readComplianceStateByDevice(
  policyId: string,
  deviceIds: string[]
): Promise<Map<string, ExistingComplianceState>> {
  const normalized = Array.from(
    new Set(deviceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
  );
  const byDevice = new Map<string, ExistingComplianceState>();
  if (normalized.length === 0) {
    return byDevice;
  }

  for (const chunk of chunkArray(normalized)) {
    const rows = await db
      .select({
        deviceId: softwareComplianceStatus.deviceId,
        status: softwareComplianceStatus.status,
        violations: softwareComplianceStatus.violations,
        remediationStatus: softwareComplianceStatus.remediationStatus,
        lastRemediationAttempt: softwareComplianceStatus.lastRemediationAttempt,
      })
      .from(softwareComplianceStatus)
      .where(and(
        eq(softwareComplianceStatus.policyId, policyId),
        inArray(softwareComplianceStatus.deviceId, chunk),
      ));

    for (const row of rows) {
      byDevice.set(row.deviceId, row);
    }
  }

  return byDevice;
}

function readRemediationOptions(raw: unknown): {
  autoUninstallEnabled: boolean;
  gracePeriodHours: number;
  cooldownMinutes: number;
} {
  if (!raw || typeof raw !== 'object') {
    return {
      autoUninstallEnabled: true,
      gracePeriodHours: 0,
      cooldownMinutes: REMEDIATION_COOLDOWN_DEFAULT_MINUTES,
    };
  }

  const options = raw as Record<string, unknown>;
  const gracePeriodHours = typeof options.gracePeriod === 'number'
    ? Math.max(0, Math.min(24 * 90, Math.floor(options.gracePeriod)))
    : 0;
  const cooldownMinutes = typeof options.cooldownMinutes === 'number'
    ? Math.max(1, Math.min(24 * 90 * 60, Math.floor(options.cooldownMinutes)))
    : REMEDIATION_COOLDOWN_DEFAULT_MINUTES;

  return {
    autoUninstallEnabled: options.autoUninstall !== false,
    gracePeriodHours,
    cooldownMinutes,
  };
}

function readEarliestUnauthorizedDetection(violations: unknown): Date | null {
  if (!Array.isArray(violations)) return null;
  let earliest: Date | null = null;

  for (const violation of violations) {
    if (!violation || typeof violation !== 'object') continue;
    const typed = violation as { type?: unknown; detectedAt?: unknown };
    if (typed.type !== 'unauthorized' || typeof typed.detectedAt !== 'string') {
      continue;
    }
    const detectedAt = new Date(typed.detectedAt);
    if (Number.isNaN(detectedAt.getTime())) continue;
    if (!earliest || detectedAt.getTime() < earliest.getTime()) {
      earliest = detectedAt;
    }
  }

  return earliest;
}

export function shouldQueueAutoRemediation(input: {
  violations: unknown;
  previousRemediationStatus: string | null;
  lastRemediationAttempt: Date | null;
  now: Date;
  gracePeriodHours: number;
  cooldownMinutes: number;
}): { queue: boolean; reason?: string } {
  if (input.previousRemediationStatus === 'pending' || input.previousRemediationStatus === 'in_progress') {
    return { queue: false, reason: 'in_progress' };
  }

  const earliestUnauthorizedAt = readEarliestUnauthorizedDetection(input.violations);
  if (input.gracePeriodHours > 0 && earliestUnauthorizedAt) {
    const graceMs = input.gracePeriodHours * 60 * 60 * 1000;
    if ((input.now.getTime() - earliestUnauthorizedAt.getTime()) < graceMs) {
      return { queue: false, reason: 'grace_period' };
    }
  }

  if (input.lastRemediationAttempt) {
    const cooldownMs = input.cooldownMinutes * 60 * 1000;
    if ((input.now.getTime() - input.lastRemediationAttempt.getTime()) < cooldownMs) {
      return { queue: false, reason: 'cooldown' };
    }
  }

  return { queue: true };
}

type ScanPoliciesJobData = {
  type: 'scan-policies';
};

type CheckPolicyJobData = {
  type: 'check-policy';
  policyId: string;
  deviceIds?: string[];
};

type SoftwareComplianceJobData = ScanPoliciesJobData | CheckPolicyJobData;

let softwareComplianceQueue: Queue<SoftwareComplianceJobData> | null = null;
let softwareComplianceWorker: Worker<SoftwareComplianceJobData> | null = null;

export function getSoftwareComplianceQueue(): Queue<SoftwareComplianceJobData> {
  if (!softwareComplianceQueue) {
    softwareComplianceQueue = new Queue<SoftwareComplianceJobData>(SOFTWARE_COMPLIANCE_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return softwareComplianceQueue;
}

async function processScanPolicies(): Promise<{ queued: number }> {
  const activePolicies = await db
    .select({ id: softwarePolicies.id })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.isActive, true));

  if (activePolicies.length === 0) {
    return { queued: 0 };
  }

  const queue = getSoftwareComplianceQueue();
  const slot = Math.floor(Date.now() / SCAN_INTERVAL_MS);

  await queue.addBulk(
    activePolicies.map((policy) => ({
      name: 'check-policy',
      data: {
        type: 'check-policy' as const,
        policyId: policy.id,
      },
      opts: {
        jobId: `software-compliance:${policy.id}:${slot}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 300 },
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      },
    }))
  );

  return { queued: activePolicies.length };
}

async function processCheckPolicy(data: CheckPolicyJobData): Promise<{
  policyId: string;
  devicesEvaluated: number;
  violations: number;
  remediationQueued: number;
}> {
  const [policy] = await db
    .select()
    .from(softwarePolicies)
    .where(and(
      eq(softwarePolicies.id, data.policyId),
      eq(softwarePolicies.isActive, true),
    ))
    .limit(1);

  if (!policy) {
    return {
      policyId: data.policyId,
      devicesEvaluated: 0,
      violations: 0,
      remediationQueued: 0,
    };
  }

  const targetDeviceIds = await resolveTargetDeviceIdsForPolicy(policy);
  let deviceIds = targetDeviceIds;
  if (Array.isArray(data.deviceIds) && data.deviceIds.length > 0) {
    const requested = new Set(data.deviceIds);
    deviceIds = targetDeviceIds.filter((id) => requested.has(id));
  }

  if (deviceIds.length === 0) {
    return {
      policyId: policy.id,
      devicesEvaluated: 0,
      violations: 0,
      remediationQueued: 0,
    };
  }

  const normalizedRules = normalizeSoftwarePolicyRules(policy.rules);
  const remediationOptions = readRemediationOptions(policy.remediationOptions);
  const { effectiveDeviceIds, shadowedByDeviceId } = await resolveEffectivePolicyDeviceIds(policy, deviceIds);
  const allImpactedDeviceIds = Array.from(new Set([...effectiveDeviceIds, ...Array.from(shadowedByDeviceId.keys())]));
  const existingByDevice = await readComplianceStateByDevice(policy.id, allImpactedDeviceIds);
  const inventoryByDevice = await getSoftwareInventoryByDeviceIds(effectiveDeviceIds);

  let violations = 0;
  const remediationTargets = new Set<string>();
  const complianceUpserts: Parameters<typeof upsertSoftwareComplianceStatuses>[0] = [];
  const now = new Date();

  for (const deviceId of shadowedByDeviceId.keys()) {
    complianceUpserts.push({
      deviceId,
      policyId: policy.id,
      status: 'unknown',
      violations: [],
      checkedAt: now,
      remediationStatus: 'none',
    });
    recordSoftwarePolicyEvaluation(policy.mode, 'unknown', 0, 'shadowed');
  }

  if (shadowedByDeviceId.size > 0) {
    fireAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      action: 'policy_precedence_applied',
      actor: 'system',
      details: {
        shadowedDevices: shadowedByDeviceId.size,
        shadowingPolicyIds: Array.from(new Set(shadowedByDeviceId.values())),
      },
    });
  }

  for (const deviceId of effectiveDeviceIds) {
    const startedAt = Date.now();
    try {
      const existing = existingByDevice.get(deviceId);
      const inventory = inventoryByDevice.get(deviceId) ?? [];
      const evaluated = evaluateSoftwarePolicyAgainstInventory(policy, inventory);
      const violationsWithStableTimestamps = withStableViolationTimestamps(
        evaluated.violations,
        existing?.violations ?? null
      );
      const status = violationsWithStableTimestamps.length > 0 ? 'violation' : 'compliant';

      let remediationStatus: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed' | undefined;
      if (status === 'compliant') {
        if (
          existing?.remediationStatus
          && existing.remediationStatus !== 'none'
          && existing.remediationStatus !== 'completed'
        ) {
          remediationStatus = 'completed';
        }
      } else if (existing?.remediationStatus === 'completed') {
        remediationStatus = 'none';
      }

      complianceUpserts.push({
        deviceId,
        policyId: policy.id,
        status,
        violations: violationsWithStableTimestamps,
        checkedAt: now,
        remediationStatus,
      });
      recordSoftwarePolicyEvaluation(policy.mode, status, Date.now() - startedAt, 'evaluated');

      if (status === 'violation') {
        violations += 1;
        recordSoftwarePolicyViolation(policy.mode, violationsWithStableTimestamps.length);

        fireAudit({
          orgId: policy.orgId,
          policyId: policy.id,
          deviceId,
          action: 'violation_detected',
          actor: 'system',
          details: {
            mode: policy.mode,
            violationCount: violationsWithStableTimestamps.length,
          },
        });

        if (
          policy.enforceMode
          && policy.mode !== 'audit'
          && remediationOptions.autoUninstallEnabled
          && violationsWithStableTimestamps.some((violation) => violation.type === 'unauthorized')
        ) {
          const remediationDecision = shouldQueueAutoRemediation({
            violations: violationsWithStableTimestamps,
            previousRemediationStatus: existing?.remediationStatus ?? null,
            lastRemediationAttempt: existing?.lastRemediationAttempt ?? null,
            now,
            gracePeriodHours: remediationOptions.gracePeriodHours,
            cooldownMinutes: remediationOptions.cooldownMinutes,
          });

          if (remediationDecision.queue) {
            remediationTargets.add(deviceId);
            recordSoftwareRemediationDecision('queued');
          } else {
            recordSoftwareRemediationDecision(remediationDecision.reason ?? 'skipped');
          }
        }
      }
    } catch (error) {
      console.error(
        `[SoftwareComplianceWorker] Compliance evaluation failed for device ${deviceId} (policy ${policy.id}):`,
        error
      );
      complianceUpserts.push({
        deviceId,
        policyId: policy.id,
        status: 'unknown',
        violations: [],
        checkedAt: now,
      });
      recordSoftwarePolicyEvaluation(policy.mode, 'unknown', Date.now() - startedAt, 'error');

      fireAudit({
        orgId: policy.orgId,
        policyId: policy.id,
        deviceId,
        action: 'compliance_check_failed',
        actor: 'system',
        details: {
          mode: policy.mode,
          error: error instanceof Error ? error.message : 'Unknown compliance evaluation error',
        },
      });
    }
  }

  if (complianceUpserts.length > 0) {
    await upsertSoftwareComplianceStatuses(complianceUpserts);
  }

  let remediationQueued = 0;
  const remediationTargetIds = Array.from(remediationTargets);
  if (remediationTargetIds.length > 0) {
    remediationQueued = await scheduleSoftwareRemediation(policy.id, remediationTargetIds);

    if (remediationQueued > 0) {
      for (const chunk of chunkArray(remediationTargetIds)) {
        await db
          .update(softwareComplianceStatus)
          .set({
            remediationStatus: 'pending',
            lastRemediationAttempt: new Date(),
          })
          .where(and(
            eq(softwareComplianceStatus.policyId, policy.id),
            inArray(softwareComplianceStatus.deviceId, chunk),
          ));
      }
    }

    fireAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      action: 'remediation_scheduled',
      actor: 'system',
      details: {
        targetCount: remediationTargetIds.length,
        queuedCount: remediationQueued,
        deferredCount: Math.max(0, remediationTargetIds.length - remediationQueued),
        ruleCount: normalizedRules.software.length,
      },
    });

    recordSoftwareRemediationDecision('scheduled', remediationQueued);
  }

  return {
    policyId: policy.id,
    devicesEvaluated: effectiveDeviceIds.length,
    violations,
    remediationQueued,
  };
}

export function createSoftwareComplianceWorker(): Worker<SoftwareComplianceJobData> {
  return new Worker<SoftwareComplianceJobData>(
    SOFTWARE_COMPLIANCE_QUEUE,
    async (job: Job<SoftwareComplianceJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'scan-policies') {
          return processScanPolicies();
        }
        return processCheckPolicy(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 4,
      settings: {
        backoffStrategy: (attemptsMade: number) => Math.min(attemptsMade * 5000, 30000),
      },
    }
  );
}

async function scheduleComplianceScan(): Promise<void> {
  const queue = getSoftwareComplianceQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'scan-policies') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'scan-policies',
    { type: 'scan-policies' },
    {
      repeat: { every: SCAN_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    }
  );
}

export async function initializeSoftwareComplianceWorker(): Promise<void> {
  softwareComplianceWorker = createSoftwareComplianceWorker();

  softwareComplianceWorker.on('error', (error) => {
    console.error('[SoftwareComplianceWorker] Worker error:', error);
  });

  softwareComplianceWorker.on('failed', (job, error) => {
    console.error(`[SoftwareComplianceWorker] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleComplianceScan();
    console.log('[SoftwareComplianceWorker] Initialized');
  } catch (error) {
    console.error('[SoftwareComplianceWorker] Failed to schedule compliance scan — scans will not run:', error);
    captureException(error);
  }
}

export async function shutdownSoftwareComplianceWorker(): Promise<void> {
  if (softwareComplianceWorker) {
    await softwareComplianceWorker.close();
    softwareComplianceWorker = null;
  }

  if (softwareComplianceQueue) {
    await softwareComplianceQueue.close();
    softwareComplianceQueue = null;
  }
}

export async function scheduleSoftwareComplianceCheck(
  policyId?: string,
  deviceIds?: string[]
): Promise<string> {
  const queue = getSoftwareComplianceQueue();
  const uniqueDeviceIds = Array.isArray(deviceIds)
    ? Array.from(new Set(deviceIds.filter((id) => typeof id === 'string' && id.length > 0)))
    : undefined;

  const job = await queue.add(
    policyId ? 'check-policy' : 'scan-policies',
    policyId
      ? {
        type: 'check-policy',
        policyId,
        deviceIds: uniqueDeviceIds,
      }
      : {
        type: 'scan-policies',
      },
    {
      jobId: policyId
        ? [
          'software-compliance',
          policyId,
          stableShortHash(JSON.stringify(uniqueDeviceIds ?? [])),
          Math.floor(Date.now() / ON_DEMAND_DEDUPE_WINDOW_MS).toString(36),
        ].join(':')
        : undefined,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 5000 },
    }
  );

  return String(job.id);
}
