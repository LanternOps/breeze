import { Job, Queue, Worker } from 'bullmq';
import { and, eq, gte, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { deviceCommands, softwareComplianceStatus, softwarePolicies } from '../db/schema';
import { recordSoftwareRemediationDecision } from '../routes/metrics';
import { getRedisConnection } from '../services/redis';
import { CommandTypes, queueCommand } from '../services/commandQueue';
import { recordSoftwarePolicyAudit } from '../services/softwarePolicyService';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function fireAudit(input: Parameters<typeof recordSoftwarePolicyAudit>[0]): void {
  recordSoftwarePolicyAudit(input).catch((err) => {
    console.error('[SoftwareRemediationWorker] Audit write failed:', err);
  });
}

const SOFTWARE_REMEDIATION_QUEUE = 'software-remediation';
const DEFAULT_REMEDIATION_COOLDOWN_MINUTES = 120;
const IN_FLIGHT_LOOKBACK_MINUTES = 24 * 60;

type RemediateDeviceJobData = {
  type: 'remediate-device';
  policyId: string;
  deviceId: string;
};

type SoftwareRemediationJobData = RemediateDeviceJobData;

let softwareRemediationQueue: Queue<SoftwareRemediationJobData> | null = null;
let softwareRemediationWorker: Worker<SoftwareRemediationJobData> | null = null;

export function getSoftwareRemediationQueue(): Queue<SoftwareRemediationJobData> {
  if (!softwareRemediationQueue) {
    softwareRemediationQueue = new Queue<SoftwareRemediationJobData>(SOFTWARE_REMEDIATION_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return softwareRemediationQueue;
}

type RemediationError = {
  softwareName?: string;
  message: string;
};

function readCooldownMinutes(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return DEFAULT_REMEDIATION_COOLDOWN_MINUTES;
  const options = raw as Record<string, unknown>;
  if (typeof options.cooldownMinutes !== 'number') return DEFAULT_REMEDIATION_COOLDOWN_MINUTES;
  return Math.max(1, Math.min(24 * 90 * 60, Math.floor(options.cooldownMinutes)));
}

function normalizeSoftwareKey(name: string, version: string | null | undefined): string {
  return `${name.trim().toLowerCase()}::${(version ?? '').trim().toLowerCase()}`;
}

async function readInFlightUninstallKeys(
  deviceId: string,
  policyId: string
): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - IN_FLIGHT_LOOKBACK_MINUTES * 60 * 1000);
  const rows = await db
    .select({ payload: deviceCommands.payload })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, deviceId),
      eq(deviceCommands.type, CommandTypes.SOFTWARE_UNINSTALL),
      gte(deviceCommands.createdAt, cutoff),
      sql`${deviceCommands.status} IN ('pending', 'sent')`,
      sql`(${deviceCommands.payload} ->> 'policyId') = ${policyId}`,
    ));

  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.payload || typeof row.payload !== 'object') continue;
    const payload = row.payload as Record<string, unknown>;
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) continue;
    const version = typeof payload.version === 'string' ? payload.version : undefined;
    keys.add(normalizeSoftwareKey(name, version));
  }

  return keys;
}

async function processRemediateDevice(data: RemediateDeviceJobData): Promise<{
  policyId: string;
  deviceId: string;
  commandsQueued: number;
  errors: number;
}> {
  const [policy] = await db
    .select({
      id: softwarePolicies.id,
      orgId: softwarePolicies.orgId,
      name: softwarePolicies.name,
      isActive: softwarePolicies.isActive,
      remediationOptions: softwarePolicies.remediationOptions,
    })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.id, data.policyId))
    .limit(1);

  if (!policy || !policy.isActive) {
    return {
      policyId: data.policyId,
      deviceId: data.deviceId,
      commandsQueued: 0,
      errors: 0,
    };
  }

  const [compliance] = await db
    .select()
    .from(softwareComplianceStatus)
    .where(and(
      eq(softwareComplianceStatus.policyId, data.policyId),
      eq(softwareComplianceStatus.deviceId, data.deviceId),
    ))
    .limit(1);

  if (!compliance) {
    return {
      policyId: data.policyId,
      deviceId: data.deviceId,
      commandsQueued: 0,
      errors: 0,
    };
  }

  const now = new Date();
  const cooldownMinutes = readCooldownMinutes(policy.remediationOptions);
  if (compliance.lastRemediationAttempt) {
    const nextEligibleAt = new Date(compliance.lastRemediationAttempt.getTime() + (cooldownMinutes * 60 * 1000));
    if (nextEligibleAt.getTime() > now.getTime()) {
      const deferredMessage = `Remediation cooldown active until ${nextEligibleAt.toISOString()}`;
      await db
        .update(softwareComplianceStatus)
        .set({
          remediationStatus: 'pending',
          remediationErrors: [{ message: deferredMessage }],
        })
        .where(eq(softwareComplianceStatus.id, compliance.id));

      fireAudit({
        orgId: policy.orgId,
        policyId: policy.id,
        deviceId: data.deviceId,
        action: 'remediation_deferred',
        actor: 'system',
        details: {
          policyName: policy.name,
          cooldownMinutes,
          nextEligibleAt: nextEligibleAt.toISOString(),
        },
      });
      recordSoftwareRemediationDecision('cooldown');

      return {
        policyId: data.policyId,
        deviceId: data.deviceId,
        commandsQueued: 0,
        errors: 0,
      };
    }
  }

  await db
    .update(softwareComplianceStatus)
    .set({
      remediationStatus: 'in_progress',
      lastRemediationAttempt: now,
      remediationErrors: null,
    })
    .where(eq(softwareComplianceStatus.id, compliance.id));

  try {
    const rawViolations = Array.isArray(compliance.violations) ? compliance.violations : [];
    const unauthorizedViolations: Array<{
      software?: {
        name?: string;
        version?: string | null;
      };
    }> = [];
    const seenViolationKeys = new Set<string>();
    for (const violation of rawViolations) {
      if (!violation || typeof violation !== 'object') continue;
      const typed = violation as {
        type?: string;
        software?: { name?: string; version?: string | null };
      };
      if (typed.type !== 'unauthorized') continue;
      const softwareName = typed.software?.name?.trim();
      if (!softwareName) continue;
      const key = normalizeSoftwareKey(softwareName, typed.software?.version ?? undefined);
      if (seenViolationKeys.has(key)) continue;
      seenViolationKeys.add(key);
      unauthorizedViolations.push(typed);
    }

    if (unauthorizedViolations.length === 0) {
      await db
        .update(softwareComplianceStatus)
        .set({
          remediationStatus: 'completed',
          lastRemediationAttempt: now,
        })
        .where(eq(softwareComplianceStatus.id, compliance.id));
      recordSoftwareRemediationDecision('no_violations');

      return {
        policyId: data.policyId,
        deviceId: data.deviceId,
        commandsQueued: 0,
        errors: 0,
      };
    }

    const remediationErrors: RemediationError[] = [];
    const inFlightKeys = await readInFlightUninstallKeys(data.deviceId, policy.id);
    let skippedInFlight = 0;
    let commandsQueued = 0;

    for (const violation of unauthorizedViolations) {
      const softwareName = violation.software?.name?.trim();
      if (!softwareName) {
        remediationErrors.push({ message: 'Unauthorized violation missing software name' });
        continue;
      }

      const softwareVersion = violation.software?.version ?? undefined;
      const key = normalizeSoftwareKey(softwareName, softwareVersion);
      if (inFlightKeys.has(key)) {
        skippedInFlight += 1;
        recordSoftwareRemediationDecision('command_deduped');
        continue;
      }

      try {
        await queueCommand(
          data.deviceId,
          CommandTypes.SOFTWARE_UNINSTALL,
          {
            name: softwareName,
            version: softwareVersion,
            policyId: policy.id,
            complianceStatusId: compliance.id,
            source: 'software_policy',
          }
        );
        commandsQueued += 1;
        inFlightKeys.add(key);
        recordSoftwareRemediationDecision('command_queued');
      } catch (error) {
        remediationErrors.push({
          softwareName,
          message: error instanceof Error ? error.message : 'Failed to queue uninstall command',
        });
        recordSoftwareRemediationDecision('command_failed');
      }
    }

    const remediationStatus = (() => {
      if (commandsQueued > 0 || skippedInFlight > 0) return 'pending';
      if (remediationErrors.length > 0) return 'failed';
      return 'completed';
    })();

    await db
      .update(softwareComplianceStatus)
      .set({
        remediationStatus,
        lastRemediationAttempt: now,
        remediationErrors: remediationErrors.length > 0 ? remediationErrors : null,
      })
      .where(eq(softwareComplianceStatus.id, compliance.id));

    const action = remediationErrors.length > 0
      ? (commandsQueued > 0 ? 'remediation_partial' : 'remediation_failed')
      : (skippedInFlight > 0 && commandsQueued === 0 ? 'remediation_deferred' : 'remediation_queued');
    fireAudit({
      orgId: policy.orgId,
      policyId: policy.id,
      deviceId: data.deviceId,
      action,
      actor: 'system',
      details: {
        policyName: policy.name,
        unauthorizedViolations: unauthorizedViolations.length,
        commandsQueued,
        skippedInFlight,
        errors: remediationErrors,
      },
    });

    return {
      policyId: data.policyId,
      deviceId: data.deviceId,
      commandsQueued,
      errors: remediationErrors.length,
    };
  } catch (error) {
    console.error(`[SoftwareRemediationWorker] Unhandled error for device ${data.deviceId}, policy ${data.policyId}:`, error);
    await db
      .update(softwareComplianceStatus)
      .set({
        remediationStatus: 'failed',
        remediationErrors: [{ message: error instanceof Error ? error.message : 'Internal remediation error' }],
      })
      .where(eq(softwareComplianceStatus.id, compliance.id))
      .catch((resetErr: unknown) => {
        console.error('[SoftwareRemediationWorker] Failed to reset remediationStatus to failed:', resetErr);
      });
    throw error;
  }
}

export function createSoftwareRemediationWorker(): Worker<SoftwareRemediationJobData> {
  return new Worker<SoftwareRemediationJobData>(
    SOFTWARE_REMEDIATION_QUEUE,
    async (job: Job<SoftwareRemediationJobData>) => {
      return runWithSystemDbAccess(async () => {
        return processRemediateDevice(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      settings: {
        backoffStrategy: (attemptsMade: number) => Math.min(attemptsMade * 5000, 30000),
      },
    }
  );
}

export async function initializeSoftwareRemediationWorker(): Promise<void> {
  softwareRemediationWorker = createSoftwareRemediationWorker();

  softwareRemediationWorker.on('error', (error) => {
    console.error('[SoftwareRemediationWorker] Worker error:', error);
  });

  softwareRemediationWorker.on('failed', (job, error) => {
    console.error(`[SoftwareRemediationWorker] Job ${job?.id} failed:`, error);
  });

  console.log('[SoftwareRemediationWorker] Initialized');
}

export async function shutdownSoftwareRemediationWorker(): Promise<void> {
  if (softwareRemediationWorker) {
    await softwareRemediationWorker.close();
    softwareRemediationWorker = null;
  }

  if (softwareRemediationQueue) {
    await softwareRemediationQueue.close();
    softwareRemediationQueue = null;
  }
}

export async function scheduleSoftwareRemediation(
  policyId: string,
  deviceIds: string[]
): Promise<number> {
  const uniqueDeviceIds = Array.from(new Set(deviceIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (uniqueDeviceIds.length === 0) {
    return 0;
  }

  const queue = getSoftwareRemediationQueue();
  let queued = 0;
  for (const deviceId of uniqueDeviceIds) {
    const jobId = `software-remediation:${policyId}:${deviceId}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      recordSoftwareRemediationDecision('job_deduped');
      continue;
    }

    await queue.add(
      'remediate-device',
      {
        type: 'remediate-device',
        policyId,
        deviceId,
      },
      {
        jobId,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      }
    );
    queued += 1;
  }

  return queued;
}
