import { Job, Queue, Worker } from 'bullmq';
import { and, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { deviceCommands, devices, softwareComplianceStatus, softwarePolicies, softwareRemediationRequests, type RemediationError } from '../db/schema';
import { recordSoftwareRemediationDecision } from '../routes/metrics';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { CommandTypes, queueCommand } from '../services/commandQueue';
import { evaluateSoftwarePolicyArming, recordSoftwarePolicyAudit } from '../services/softwarePolicyService';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

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
// #3553: how long a minted manual authorization stays valid if its job never
// runs. Generous vs the worker's retry/backoff (attempts=3, ≤30s) but bounded so
// an unconsumed authorization cannot linger indefinitely.
const MANUAL_REQUEST_TTL_MS = 60 * 60 * 1000;
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
  /**
   * #3553: id of the durable single-use software_remediation_requests row that
   * authorizes this MANUAL job. `trigger:'manual'` is only honored when this id
   * resolves to a matching, unconsumed, unexpired, ownership-coherent row —
   * otherwise the job is downgraded to `auto` and re-checked against the arming
   * gate. Absent on `auto` jobs and on pre-#3553 manual jobs (fail closed).
   */
  manualRequestId?: string;
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

export type ManualAuthorizationResult = { authorized: boolean; requestedByUserId: string | null };

/**
 * #3553: verify a job's `trigger:'manual'` claim against its durable
 * authorization row and CONSUME it (single use). A single atomic UPDATE does
 * BOTH the consume and the ownership re-check, reading the CURRENT device + policy
 * ownership INSIDE the statement (not a cached scalar) so there is no TOCTOU: a
 * device that moves orgs concurrently cannot slip an uninstall through. Authorized
 * only when the row is unconsumed, unexpired, bound to the exact (policy, device),
 * AND the device is still governed by the policy's tenancy — org policy: the
 * device's current org is the policy's org; partner-wide policy: the device's
 * current org still belongs to the policy's partner. Any miss returns
 * `authorized:false` and the caller downgrades to `auto` (fail closed). Returns
 * the TRUSTED requester from the row (never job data) for the audit trail. Runs
 * in the worker's system DB context (breeze_has_org_access short-circuits true),
 * so RLS never silently zeroes the UPDATE.
 *
 * Exported for integration tests — this is the security boundary and must be
 * exercised against real Postgres + RLS + the device-move trigger.
 */
export async function consumeManualRemediationAuthorization(input: {
  manualRequestId?: string;
  policyId: string;
  deviceId: string;
}): Promise<ManualAuthorizationResult> {
  if (!input.manualRequestId) {
    return { authorized: false, requestedByUserId: null };
  }
  const [row] = await db
    .update(softwareRemediationRequests)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(softwareRemediationRequests.id, input.manualRequestId),
      eq(softwareRemediationRequests.policyId, input.policyId),
      eq(softwareRemediationRequests.deviceId, input.deviceId),
      isNull(softwareRemediationRequests.consumedAt),
      gt(softwareRemediationRequests.expiresAt, new Date()),
      // Ownership coherence, atomic with the consume: read the device's and the
      // policy's CURRENT owners inside the UPDATE so a concurrent device move
      // cannot be raced past a cached org id.
      sql`EXISTS (
        SELECT 1 FROM devices d
        JOIN software_policies p ON p.id = ${softwareRemediationRequests.policyId}
        WHERE d.id = ${softwareRemediationRequests.deviceId}
          AND (
            (p.org_id IS NOT NULL AND d.org_id = p.org_id)
            OR (p.partner_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM organizations o WHERE o.id = d.org_id AND o.partner_id = p.partner_id
            ))
          )
      )`,
    ))
    .returning({ requestedByUserId: softwareRemediationRequests.requestedByUserId });
  if (!row) {
    return { authorized: false, requestedByUserId: null };
  }
  return { authorized: true, requestedByUserId: row.requestedByUserId ?? null };
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
  //
  // #3553: FOR UPDATE locks this device row for the worker's (single) system
  // transaction, so a concurrent device org-move blocks until we commit. Without
  // it, Read Committed lets a move commit between the manual consume's ownership
  // EXISTS and command creation (the subquery reads a statement snapshot), which
  // would let an old-tenant authorization act on a just-moved device. The lock
  // makes the ownership check and the uninstall atomic w.r.t. device retenanting.
  const [deviceRow] = await db
    .select({ orgId: devices.orgId, isEphemeral: devices.isEphemeral })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1)
    .for('update');

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
  // #3553: `trigger:'manual'` is authorization state living in forgeable BullMQ
  // job data. Verify+consume its durable single-use record; a claim that does
  // not resolve to a matching, unconsumed, unexpired, ownership-coherent row is
  // downgraded to 'auto' so the arming gate applies (fail closed). Placed after
  // the policy/device/compliance early-returns so an ineligible job never burns
  // the one-time authorization.
  const claimedTrigger = readTrigger(data);
  const manualAuth = claimedTrigger === 'manual'
    ? await consumeManualRemediationAuthorization({
        manualRequestId: data.manualRequestId,
        policyId: data.policyId,
        deviceId: data.deviceId,
      })
    : { authorized: false, requestedByUserId: null };
  const trigger: SoftwareRemediationTrigger = manualAuth.authorized ? 'manual' : 'auto';

  const arming = evaluateSoftwarePolicyArming(policy);
  // A verified manual action overrides `enforce_mode_off` / `auto_uninstall_off`
  // ONLY — NEVER `audit_mode` (#3553). A policy flipped to audit mode after the
  // operator authorized must not be bypassed; audit_mode falls through to the
  // refusal branch below.
  if (trigger === 'manual' && !arming.armed && arming.reason !== 'audit_mode') {
    // Explicit, verified human action on an enforce/auto-uninstall-off policy:
    // allowed, but never silent. Actor is the TRUSTED requester from the consumed
    // authorization row (#3553), never the forgeable job-data field.
    fireAudit({
      orgId: auditOrgId,
      partnerId: policy.partnerId,
      policyId: policy.id,
      deviceId: data.deviceId,
      action: 'remediation_manual_override',
      actor: 'user',
      actorId: manualAuth.requestedByUserId,
      details: {
        policyName: policy.name,
        reason: arming.reason,
        mode: policy.mode,
        enforceMode: policy.enforceMode,
      },
    });
    recordSoftwareRemediationDecision('manual_override');
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
  // #3553: the cooldown is an AUTO-remediation rate limit. A verified manual
  // action is a deliberate operator override (it already bypasses arming), so it
  // bypasses the cooldown too. This is also correctness-critical: the remediate
  // route writes lastRemediationAttempt=now in its own request transaction, so a
  // manual job that consumed its single-use token and then hit the cooldown would
  // burn the authorization and skip with zero commands (no retry). Bypassing it
  // for verified manual keeps the token and the operator's intent whole.
  // Tradeoff (intended, confirmed in #3614): an authenticated, MFA-gated
  // operator can re-trigger manual remediation without a cooldown wait.
  // Concurrent double-clicks still dedupe on the in-flight uninstall-command
  // check below; there is deliberately no separate manual throttle — a manual
  // run is an explicit human decision.
  //
  // The cooldown exists to stop the UNATTENDED worker from retrying a failing
  // policy every scheduling tick. A human who has just passed MFA and burned a
  // single-use authorization row (#3585) has already cleared a stricter gate
  // than the cooldown, and making them wait would strand exactly the operator
  // trying to correct a bad remediation. Do not "fix" this into a throttle
  // without replacing the token semantics too: consume-then-cooldown-skip
  // would burn the row for zero queued commands and leave no way to retry.
  if (trigger !== 'manual' && compliance.lastRemediationAttempt) {
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
  attachWorkerObservability(softwareRemediationWorker, 'softwareRemediationWorker');

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

/**
 * #3553: mint one durable single-use authorization row per device for a MANUAL
 * run and COMMIT it before the caller enqueues, in a fresh system-context
 * transaction OUTSIDE the request's long-lived transaction. That ordering
 * closes the consume-before-commit race: the remediate route runs inside one
 * request-long transaction (withDbAccessContext), so a row inserted there would
 * be invisible to a fast worker that grabbed the Redis job first, and a
 * legitimate unarmed manual remediation would be wrongly downgraded to `auto`
 * and refused. Returns the minted (id, deviceId) pairs.
 */
async function createManualRemediationAuthorizations(
  policyId: string,
  deviceIds: string[],
  requestedByUserId: string | null,
): Promise<Array<{ id: string; deviceId: string }>> {
  return dbModule.runOutsideDbContext(() =>
    runWithSystemDbAccess(async () => {
      const [policy] = await db
        .select({ orgId: softwarePolicies.orgId, partnerId: softwarePolicies.partnerId })
        .from(softwarePolicies)
        .where(eq(softwarePolicies.id, policyId))
        .limit(1);
      if (!policy) {
        return [];
      }
      const deviceRows = await db
        .select({ id: devices.id, orgId: devices.orgId })
        .from(devices)
        .where(inArray(devices.id, deviceIds));
      const orgByDevice = new Map(deviceRows.map((d) => [d.id, d.orgId]));

      const expiresAt = new Date(Date.now() + MANUAL_REQUEST_TTL_MS);
      const values = deviceIds
        .filter((deviceId) => orgByDevice.has(deviceId))
        .map((deviceId) => ({
          // Dual-owner (mirrors the audit rows): org axis is the policy's org
          // for an org policy, else the device's org for a partner-wide policy;
          // partner axis is the policy's partner. At least one is always set.
          orgId: policy.orgId ?? orgByDevice.get(deviceId) ?? null,
          partnerId: policy.partnerId ?? null,
          policyId,
          deviceId,
          requestedByUserId,
          expiresAt,
        }));
      if (values.length === 0) {
        return [];
      }
      return db
        .insert(softwareRemediationRequests)
        .values(values)
        .returning({ id: softwareRemediationRequests.id, deviceId: softwareRemediationRequests.deviceId });
    }),
  );
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

  // #3553: commit the manual authorizations BEFORE enqueuing (see helper).
  const manualRequestIdByDevice = new Map<string, string>();
  if (trigger === 'manual') {
    const minted = await createManualRemediationAuthorizations(
      policyId,
      uniqueDeviceIds,
      options.requestedByUserId ?? null,
    );
    for (const row of minted) {
      manualRequestIdByDevice.set(row.deviceId, row.id);
    }
  }

  const queue = getSoftwareRemediationQueue();
  let queued = 0;
  for (const deviceId of uniqueDeviceIds) {
    const manualRequestId = trigger === 'manual' ? manualRequestIdByDevice.get(deviceId) : undefined;
    // A manual device with no minted authorization is skipped, never enqueued
    // unauthorized. This covers a device absent at mint time (filtered out of the
    // batch) or a whole-batch mint failure (e.g. the policy vanished → empty
    // result); both fail closed. (A device deleted in the tiny window between the
    // mint SELECT and its INSERT would instead throw an FK error and abort the
    // whole manual request — the operator simply retries; nothing is enqueued.)
    if (trigger === 'manual' && !manualRequestId) {
      continue;
    }

    // Separate identity domains (#3553): manual jobs key on their unique
    // authorization id, so a manual request can never dedupe into (and lose its
    // authorization to) an older auto job sharing the (policy, device) key.
    const jobId = trigger === 'manual'
      ? `software-remediation-manual-${manualRequestId}`
      : `software-remediation-${policyId}-${deviceId}`;
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
        manualRequestId,
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
