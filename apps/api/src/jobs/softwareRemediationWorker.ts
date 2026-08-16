import { Job, Queue, Worker } from 'bullmq';
import { and, eq, gte, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { deviceCommands, devices, softwareComplianceStatus, softwarePolicies, type RemediationError } from '../db/schema';
import { recordSoftwareRemediationDecision } from '../routes/metrics';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { CommandTypes, queueCommand } from '../services/commandQueue';
import { evaluateSoftwarePolicyArming, recordSoftwarePolicyAudit } from '../services/softwarePolicyService';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    const msg = '[SoftwareRemediationWorker] withSystemDbAccessContext unavailable — DB operations may bypass RLS';
    console.error(msg);
    captureException(new Error(msg));
  }
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

/**
 * How a remediation job was produced (#3543).
 *
 * - `auto`   — the compliance evaluator queued it because the policy is armed.
 *              The worker re-verifies arming before uninstalling anything.
 * - `manual` — an operator explicitly requested it through the MFA-gated,
 *              permission-gated `POST /software-policies/:id/remediate` route.
 *              `enforceMode`/`autoUninstall` authorise UNATTENDED remediation
 *              ("Enforce (auto-remediate)" in the UI), so they do not gate a
 *              deliberate human action — forcing an admin to arm automatic
 *              fleet-wide remediation just to run one reviewed uninstall would
 *              be strictly more dangerous than the click they asked for.
 *
 * Anything else — including a job enqueued before this field existed — is
 * treated as `auto` and therefore gated. Provenance fails closed.
 */
export type SoftwareRemediationTrigger = 'auto' | 'manual';

type RemediateDeviceJobData = {
  type: 'remediate-device';
  policyId: string;
  deviceId: string;
  /** Absent on jobs enqueued before #3543; read via readTrigger (fails closed). */
  trigger?: SoftwareRemediationTrigger;
  /** User id behind a `manual` trigger, for the audit trail. */
  requestedByUserId?: string | null;
};

type SoftwareRemediationJobData = RemediateDeviceJobData;

/**
 * Job data is untrusted input: BullMQ payloads live in Redis and carry no
 * authentication of their own. Only the exact literal 'manual' skips the arming
 * gate, and the worker records a loud audit event when it does, so a forged
 * override is at least always visible in the forensic trail.
 */
function readTrigger(data: RemediateDeviceJobData): SoftwareRemediationTrigger {
  return data.trigger === 'manual' ? 'manual' : 'auto';
}

let softwareRemediationQueue: Queue<SoftwareRemediationJobData> | null = null;
let softwareRemediationWorker: Worker<SoftwareRemediationJobData> | null = null;

export function getSoftwareRemediationQueue(): Queue<SoftwareRemediationJobData> {
  if (!softwareRemediationQueue) {
    softwareRemediationQueue = new Queue<SoftwareRemediationJobData>(SOFTWARE_REMEDIATION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return softwareRemediationQueue;
}

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

/** Exported for tests — the arming gate (#3543) is the last hop before an
 *  uninstall reaches a real machine and must be directly exercisable. */
export async function processRemediateDevice(data: RemediateDeviceJobData): Promise<{
  policyId: string;
  deviceId: string;
  commandsQueued: number;
  errors: number;
}> {
  const [policy] = await db
    .select({
      id: softwarePolicies.id,
      orgId: softwarePolicies.orgId,
      partnerId: softwarePolicies.partnerId,
      name: softwarePolicies.name,
      isActive: softwarePolicies.isActive,
      mode: softwarePolicies.mode,
      enforceMode: softwarePolicies.enforceMode,
      remediationOptions: softwarePolicies.remediationOptions,
    })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.id, data.policyId))
    .limit(1);

  if (!policy || !policy.isActive) {
    console.warn('[SoftwareRemediationWorker] Policy not found or inactive, skipping remediation', {
      policyId: data.policyId,
      deviceId: data.deviceId,
    });
    return {
      policyId: data.policyId,
      deviceId: data.deviceId,
      commandsQueued: 0,
      errors: 0,
    };
  }

  // Dual-owner audit rows (#2126): per-device events under a partner-wide
  // policy (policy.orgId NULL) must carry the DEVICE's org so the org admin
  // can see them, alongside the policy's partnerId.
  const [deviceRow] = await db
    .select({ orgId: devices.orgId, isEphemeral: devices.isEphemeral })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1);

  // Quick Support exclusion (defense in depth): ephemeral devices live in the
  // hidden per-partner 'quick_support' org and are a stranger's personal machine
  // borrowed for one ~20-minute session. The compliance evaluator already keeps
  // them out of the remediation queue, but this worker installs and uninstalls
  // software, so a stale or hand-enqueued job must not slip through either.
  if (deviceRow?.isEphemeral) {
    return {
      policyId: data.policyId,
      deviceId: data.deviceId,
      commandsQueued: 0,
      errors: 0,
    };
  }

  const auditOrgId = policy.orgId ?? deviceRow?.orgId ?? null;

  const [compliance] = await db
    .select()
    .from(softwareComplianceStatus)
    .where(and(
      eq(softwareComplianceStatus.policyId, data.policyId),
      eq(softwareComplianceStatus.deviceId, data.deviceId),
    ))
    .limit(1);

  if (!compliance) {
    console.warn('[SoftwareRemediationWorker] Compliance record not found', {
      policyId: data.policyId,
      deviceId: data.deviceId,
    });
    return {
      policyId: data.policyId,
      deviceId: data.deviceId,
      commandsQueued: 0,
      errors: 0,
    };
  }

  // Arming re-check (#3543, incident #3381). This worker is the last hop before
  // `software_uninstall` commands reach real machines, and until now it
  // uninstalled whatever it was handed — the gate existed only in the compliance
  // evaluator that produces `auto` jobs. Re-checking here means a policy
  // disarmed AFTER a job was enqueued (or a stale/replayed/hand-enqueued job)
  // can no longer uninstall anything. It sits after the compliance READ so a
  // refusal can be reflected on the row, but ahead of every mutation and of
  // queueCommand.
  //
  // Note on the BullMQ jobId (`software-remediation-<policy>-<device>`): an auto
  // and a manual job for the same pair share a key and can dedupe into each
  // other. That cannot produce a wrong gate outcome — auto jobs are only ever
  // produced for armed policies, so on an unarmed policy every job is manual,
  // and on an armed policy both triggers pass the gate anyway.
  const trigger = readTrigger(data);
  const arming = evaluateSoftwarePolicyArming(policy);
  if (trigger === 'manual') {
    // Explicit human action: allowed regardless of arming, but never silent.
    if (!arming.armed) {
      fireAudit({
        orgId: auditOrgId,
        partnerId: policy.partnerId,
        policyId: policy.id,
        deviceId: data.deviceId,
        action: 'remediation_manual_override',
        actor: 'user',
        actorId: data.requestedByUserId ?? null,
        details: {
          policyName: policy.name,
          reason: arming.reason,
          mode: policy.mode,
          enforceMode: policy.enforceMode,
        },
      });
      recordSoftwareRemediationDecision('manual_override');
    }
  } else if (!arming.armed) {
    console.warn('[SoftwareRemediationWorker] Policy is not armed for uninstall, skipping remediation', {
      policyId: policy.id,
      deviceId: data.deviceId,
      reason: arming.reason,
    });
    fireAudit({
      orgId: auditOrgId,
      partnerId: policy.partnerId,
      policyId: policy.id,
      deviceId: data.deviceId,
      action: 'remediation_skipped_unarmed',
      actor: 'system',
      details: {
        policyName: policy.name,
        reason: arming.reason,
        mode: policy.mode,
        enforceMode: policy.enforceMode,
        trigger,
      },
    });
    recordSoftwareRemediationDecision('policy_not_armed');

    // The row must not be left at the enqueue-time 'pending': softwareComplianceWorker
    // rewrites any non-terminal remediationStatus to 'completed' once the device
    // next scans compliant, which would claim Breeze's uninstall succeeded when it
    // was refused and never ran. Record the refusal and its reason instead.
    await db
      .update(softwareComplianceStatus)
      .set({
        remediationStatus: 'failed',
        remediationErrors: [{
          message: `Remediation skipped: policy is not armed for uninstall (${arming.reason}).`,
        }],
      })
      .where(eq(softwareComplianceStatus.id, compliance.id))
      .catch((err: unknown) => {
        console.error('[SoftwareRemediationWorker] Failed to record refused remediation status:', err);
        captureException(err);
      });

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
        orgId: auditOrgId,
        partnerId: policy.partnerId,
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
      orgId: auditOrgId,
      partnerId: policy.partnerId,
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
      connection: getBullMQConnection(),
      concurrency: 5,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
      settings: {
        backoffStrategy: (attemptsMade: number) => Math.min(attemptsMade * 5000, 30000),
      },
    }
  );
}

export async function initializeSoftwareRemediationWorker(): Promise<void> {
  softwareRemediationWorker = createSoftwareRemediationWorker();

  softwareRemediationWorker.on('error', (error) => {
    console.error('[SoftwareRemediationWorker] Worker error', { error });
    captureException(error);
  });

  softwareRemediationWorker.on('failed', (job, error) => {
    console.error('[SoftwareRemediationWorker] Job failed', {
      jobId: job?.id,
      policyId: (job?.data as RemediateDeviceJobData | undefined)?.policyId,
      deviceId: (job?.data as RemediateDeviceJobData | undefined)?.deviceId,
      error,
    });
    captureException(error);
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
  deviceIds: string[],
  // Defaults to the gated path: a caller that says nothing gets `auto`, so a
  // new producer cannot accidentally inherit the manual override (#3543).
  options: { trigger?: SoftwareRemediationTrigger; requestedByUserId?: string | null } = {}
): Promise<number> {
  const trigger: SoftwareRemediationTrigger = options.trigger === 'manual' ? 'manual' : 'auto';
  const uniqueDeviceIds = Array.from(new Set(deviceIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (uniqueDeviceIds.length === 0) {
    return 0;
  }

  const queue = getSoftwareRemediationQueue();
  let queued = 0;
  for (const deviceId of uniqueDeviceIds) {
    const jobId = `software-remediation-${policyId}-${deviceId}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        recordSoftwareRemediationDecision('job_deduped');
        continue;
      }
      await existing.remove().catch((err) => {
        console.warn('[SoftwareRemediationWorker] Failed to remove stale job (non-fatal):', { jobId, error: err });
      });
    }

    await queue.add(
      'remediate-device',
      {
        type: 'remediate-device',
        policyId,
        deviceId,
        trigger,
        requestedByUserId: trigger === 'manual' ? (options.requestedByUserId ?? null) : null,
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
