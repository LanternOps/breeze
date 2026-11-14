/**
 * Creating and cancelling reattach intents (#8318 wave 1b, spec §4.3, §6.5,
 * §8).
 *
 * `requestDeviceReattach` is what `POST /devices/:sourceId/reattach`
 * (routes/devices/reattach.ts, wave 2-2) calls. Besides the §8 refusals it
 * owns the two typed confirmations of the dialog — `confirmTargetName` for
 * `hint` evidence and `acknowledgeOsChange` — and, when the deployment has
 * two-factor authentication on, the `device_reattach` step-up: its binding
 * carries the opaque target version (targetVersion.ts), verified HERE against
 * the locked target row (its agent_id and incarnation as they are now), and
 * the grant is consumed (Redis GETDEL, F20) after every
 * refusal check, just before the insert, so a refusal never burns it. The
 * consumed grant id is the only value ever stored as `step_up_grant_ref`
 * (then on the ledger).
 *
 * First, unlocked (reachability.ts): the requester and where both devices
 * are. A device that does not exist, is in another partner, or is outside the
 * requester's reach answers one 404 `device_not_found`, and its row is never
 * locked.
 *
 * Then everything runs in ONE system transaction (the conflict and
 * eligibility checks must see every intent and the ledger, which a
 * technician's context cannot):
 *   1. the partner's holding-area advisory lock, unconditionally (every intent
 *      creation takes it, which makes "a device is in at most one open intent
 *      in either role" race-free; the partial unique indexes are the
 *      backstop);
 *   2. both device rows FOR UPDATE, ascending id order;
 *   3. reachability again (authoritative), the refusals of §8, the target
 *      version (`target_changed`) and the typed confirmations;
 *   4. with step-up: the actor's assurance and live session (FOR SHARE), the
 *      grant validated against the binding (a mismatch keeps it), then
 *      consumed;
 *   5. the insert of the `requested` intent with the versions the human
 *      authorized and `expires_at = now + 60 min`.
 * Audit `device.reinstall.requested` in both orgs after commit.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceReattachIntents, devices, users, type DeviceReattachEvidenceLevel, type DeviceReattachIntent } from '../../db/schema';
import { lockPartnerHoldingArea } from '../unassignedPool/holdingAreaLock';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { isHiddenOrgType } from '../unassignedPool/visibility';
import { canActorReattach, loadReattachActor, type ReattachAccessDenial } from './access';
import { writeReattachAudit } from './audit';
import { reattachRefusal, ReattachRefusedError, type ReattachRefusal } from './errors';
import {
  anyDeviceInOpenIntent,
  endIntentInTransaction,
  lockReattachDevices,
  readIntentForUpdate,
  revokeCertificatesAfterCommit,
  wasRetiredReattachSource,
  type LockedReattachDevice,
} from './intentStore';
import { decideTargetLiveness, readRedisLivenessSignals } from './liveness';
import { REATTACH_REQUESTED_TTL_MS, REATTACH_TARGET_VERSION_PATTERN, type ReattachCancelReason } from './protocol';
import { isLiveOrg } from './revalidation';
import { clearReattachSourceMarker, setReattachSourceMarker } from './sourceMarker';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import type { AuthContext } from '../../middleware/auth';
import {
  consumeStepUpGrant,
  deviceReattachResourceDigest,
  validateStepUpGrant,
  type StepUpGrantBinding,
} from '../mfaStepUpGrant';
import { lockActorAssurance } from '../stepUpActorAssurance';
import { lockLiveUserSession } from '../unassignedPool/assignParkedDeviceSteps';
import { isReattachDeviceReachable, readReattachDeviceLocations } from './reachability';
import { reattachTargetVersionMatches } from './targetVersion';

const ACCESS_DENIAL_STATUS: Record<ReattachAccessDenial, 403 | 409> = {
  not_partner_user: 403,
  user_inactive: 403,
  partner_mismatch: 409,
  permission_denied: 403,
  org_access_denied: 403,
  full_admin_required: 403,
};

const ACCESS_DENIAL_MESSAGES: Record<ReattachAccessDenial, string> = {
  not_partner_user: 'Only a partner user can reattach a device',
  user_inactive: 'The requesting user is not active',
  partner_mismatch: 'The source and the target are not both in your partner',
  permission_denied: 'Reattaching needs devices:write and devices:delete',
  org_access_denied: 'You do not have access to the organizations this reattach touches',
  full_admin_required: 'Reattaching a parked device needs a full partner admin',
};

export interface RequestDeviceReattachInput {
  actor: { userId: string };
  sourceDeviceId: string;
  targetDeviceId: string;
  evidenceLevel: DeviceReattachEvidenceLevel;
  restoreDecommissioned: boolean;
  /**
   * The opaque version of the target's install the requester was shown
   * (targetVersion.ts, from the candidates read). Compared in constant time
   * with the version of the LOCKED target row: a target that re-enrolled or
   * was reattached since answers 409 `target_changed`.
   */
  targetVersion: string;
  /**
   * The target's hostname, typed by the requester. Required for `hint`
   * evidence (§8 "Confirmation"): compared, trimmed and case-insensitively,
   * with the locked target row.
   */
  confirmTargetName?: string | null;
  /** The requester saw that the two installs report different operating systems (§8). */
  acknowledgeOsChange?: boolean;
  /**
   * The `device_reattach` step-up (§8). Required, and explicit:
   *  - `grant`: `grantId` must name a grant minted for exactly this pair,
   *    target version, evidence level and restore choice; a missing one
   *    answers 403 `STEP_UP_REQUIRED` after every other refusal. The consumed
   *    grant id is the only `step_up_grant_ref` ever recorded.
   *  - `not_required`: ONLY when the deployment has two-factor authentication
   *    off (`ENABLE_2FA`), as on the pre-assignment routes.
   * Any other value (a JS caller omitting it) is refused, never treated as
   * "no step-up".
   */
  stepUp: ReattachStepUp;
  /** Test seam. */
  now?: Date;
}

export type ReattachStepUp =
  | {
    kind: 'grant';
    grantId: string | null | undefined;
    auth: AuthContext;
    binding: Pick<StepUpGrantBinding, 'authEpoch' | 'mfaEpoch' | 'sid'>;
  }
  | { kind: 'not_required' };

export type RequestDeviceReattachResult =
  | { ok: true; intent: DeviceReattachIntent }
  | ReattachRefusal;

function refuse(status: ReattachRefusal['status'], code: string, message: string): never {
  throw new ReattachRefusedError(reattachRefusal(status, code, message));
}

/** The device-side refusals shared by both roles. */
function refuseUnhealthy(device: LockedReattachDevice, role: 'source' | 'target'): void {
  if (device.status === 'quarantined') refuse(409, 'device_quarantined', `The ${role} device is quarantined`);
  if (device.agentTokenSuspendedAt) refuse(409, 'device_suspended', `The ${role} device's agent credentials are suspended`);
}

/** An org a reattach may touch: active or trial, not soft-deleted (the same test phase 1 and confirm repeat). */
function refuseDrainingOrg(device: LockedReattachDevice, role: 'source' | 'target'): void {
  if (!isLiveOrg(device)) refuse(409, 'org_draining', `The ${role} device's organization is not active`);
}

const STEP_UP_REQUIRED_MESSAGE = 'Step-up required';

/** One answer for "does not exist" and "not yours": the same status, code and message. */
const DEVICE_NOT_FOUND = reattachRefusal(404, 'device_not_found', 'Device not found');

/** How a hostname is compared for the typed confirmation: trimmed, case-insensitive (DNS names are). */
function sameHostname(typed: string, actual: string): boolean {
  return typed.trim().toLowerCase() === actual.trim().toLowerCase();
}

/** The target's install, read unlocked before the transaction, for the Redis liveness half. */
async function readTargetInstall(targetDeviceId: string): Promise<{ agentId: string } | null> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, targetDeviceId))
    .limit(1)));
  return row ?? null;
}

export async function requestDeviceReattach(input: RequestDeviceReattachInput): Promise<RequestDeviceReattachResult> {
  const now = input.now ?? new Date();
  if (input.sourceDeviceId === input.targetDeviceId) {
    return reattachRefusal(400, 'same_device', 'A device cannot be reattached onto itself');
  }
  if (input.evidenceLevel !== 'hint' && input.evidenceLevel !== 'tpm_continuity') {
    return reattachRefusal(400, 'invalid_evidence_level', 'Unknown evidence level');
  }
  // Fail closed: a step-up that is neither a grant nor an explicit
  // "not required" is a missing grant, not an exemption.
  const stepUp = input.stepUp as ReattachStepUp | null | undefined;
  if (!stepUp || (stepUp.kind !== 'grant' && stepUp.kind !== 'not_required')) {
    return reattachRefusal(403, 'STEP_UP_REQUIRED', STEP_UP_REQUIRED_MESSAGE);
  }
  if (stepUp.kind === 'grant' && stepUp.auth.user.id !== input.actor.userId) {
    throw new Error('requestDeviceReattach: the step-up actor is not the requester');
  }
  if (typeof input.targetVersion !== 'string' || !REATTACH_TARGET_VERSION_PATTERN.test(input.targetVersion)) {
    return reattachRefusal(400, 'invalid_target_version', 'The target version is missing or malformed');
  }

  // Reachability, BEFORE any lock and before any state-specific refusal
  // (reachability.ts): a device the requester may not reach is the same 404
  // as one that does not exist, and its row is never locked.
  const pre = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({ partnerId: users.partnerId })
      .from(users)
      .where(eq(users.id, input.actor.userId))
      .limit(1);
    if (!user?.partnerId) return reattachRefusal(403, 'not_partner_user', ACCESS_DENIAL_MESSAGES.not_partner_user);
    const actor = await loadReattachActor(db, input.actor.userId, user.partnerId);
    if (!actor?.membership) return reattachRefusal(403, 'not_partner_user', ACCESS_DENIAL_MESSAGES.not_partner_user);
    if (actor.status !== 'active') return reattachRefusal(403, 'user_inactive', ACCESS_DENIAL_MESSAGES.user_inactive);
    const locations = await readReattachDeviceLocations(db, [input.sourceDeviceId, input.targetDeviceId]);
    if (
      !isReattachDeviceReachable(actor, user.partnerId, locations.get(input.sourceDeviceId), 'source')
      || !isReattachDeviceReachable(actor, user.partnerId, locations.get(input.targetDeviceId), 'target')
    ) {
      return DEVICE_NOT_FOUND;
    }
    return null;
  }));
  if (pre) return pre;

  // §6.5 at request (§8 refusals `target_alive` / `liveness_unknown`): the
  // Redis half is read BEFORE any lock, outside every DB context; the DB half
  // comes from the target row locked below. Confirm checks again.
  const targetInstall = await readTargetInstall(input.targetDeviceId);
  const redisLiveness = targetInstall
    ? await readRedisLivenessSignals({ deviceId: input.targetDeviceId, agentId: targetInstall.agentId })
    : null;

  let created: { intent: DeviceReattachIntent; source: LockedReattachDevice; target: LockedReattachDevice };
  try {
    created = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const [user] = await tx
        .select({ partnerId: users.partnerId })
        .from(users)
        .where(eq(users.id, input.actor.userId))
        .limit(1);
      if (!user?.partnerId) refuse(403, 'not_partner_user', ACCESS_DENIAL_MESSAGES.not_partner_user);
      const partnerId = user.partnerId;

      await lockPartnerHoldingArea(tx, partnerId);
      const locked = await lockReattachDevices(tx, [input.sourceDeviceId, input.targetDeviceId], 'update');
      const source = locked.get(input.sourceDeviceId);
      const target = locked.get(input.targetDeviceId);
      if (!source || !target) throw new ReattachRefusedError(DEVICE_NOT_FOUND);

      // One partner (§8). Both rows were in the requester's partner at the
      // unlocked check, so a mismatch here is a move during the request.
      if (source.orgPartnerId !== partnerId || target.orgPartnerId !== partnerId) {
        refuse(409, 'partner_mismatch', ACCESS_DENIAL_MESSAGES.partner_mismatch);
      }
      // Reachability again, authoritative under the locks: a row that left the
      // requester's reach meanwhile is the same 404.
      const actor = await loadReattachActor(tx, input.actor.userId, partnerId);
      if (
        !isReattachDeviceReachable(actor, partnerId, source, 'source')
        || !isReattachDeviceReachable(actor, partnerId, target, 'target')
      ) {
        throw new ReattachRefusedError(DEVICE_NOT_FOUND);
      }
      // Before the access rule: a draining org is out of everyone's reach,
      // and this is the precise answer.
      refuseDrainingOrg(source, 'source');
      refuseDrainingOrg(target, 'target');
      // A target is a record people manage and see: never one in a hidden org
      // (the holding org, a Quick Support org). Before the access rule too,
      // which would otherwise answer it as an org nobody can reach.
      if (isHiddenOrgType(target.orgType)) {
        refuse(409, 'target_ineligible', 'The target device is not a managed record');
      }
      const sourceParked = isUnassignedPoolOrgType(source.orgType);

      const access = canActorReattach(actor, {
        partnerId,
        sourceOrgId: source.orgId,
        sourceParked,
        targetOrgId: target.orgId,
      });
      if (!access.allowed) {
        refuse(ACCESS_DENIAL_STATUS[access.code], access.code, ACCESS_DENIAL_MESSAGES[access.code]);
      }

      // The install the requester was shown is still the target's install.
      if (!reattachTargetVersionMatches(input.targetVersion, {
        targetDeviceId: target.id,
        agentId: target.agentId,
        installIncarnation: target.installIncarnation,
      })) {
        refuse(409, 'target_changed', 'The existing device record changed since it was shown; reload and try again');
      }

      // The source: a new install that speaks the rebind protocol.
      if (source.rebindProtocolVersion < 1) {
        refuse(409, 'rebind_unsupported', 'The source agent does not support the rebind protocol; upgrade it first');
      }
      if (source.status === 'decommissioned') refuse(409, 'source_decommissioned', 'The source device is removed');
      if (source.isEphemeral) refuse(409, 'source_ineligible', 'A Quick Support device cannot be a reattach source');
      refuseUnhealthy(source, 'source');

      // The target: an existing, managed, non-ephemeral record.
      if (target.isEphemeral) refuse(409, 'target_ephemeral', 'The target device is ephemeral');
      if (target.status === 'decommissioned' && !input.restoreDecommissioned) {
        refuse(409, 'target_decommissioned', 'The target device is removed; restoring it must be explicit');
      }
      refuseUnhealthy(target, 'target');

      // Competition (§6.5), under the holding-area lock.
      if (await anyDeviceInOpenIntent(tx, [source.id, target.id])) {
        refuse(409, 'device_in_open_intent', 'One of the devices is already in an open reattach');
      }
      if (await wasRetiredReattachSource(tx, target.id)) {
        refuse(409, 'target_retired', 'The target was the source of a confirmed reattach and is retired');
      }

      // §6.5: the target must be silent. Its install changing since the
      // unlocked read is itself a credential use (an F3 re-enroll).
      if (!targetInstall || !redisLiveness || targetInstall.agentId !== target.agentId) {
        refuse(409, 'target_alive', 'The target device is in use: it authenticated recently');
      }
      const liveness = decideTargetLiveness(redisLiveness, target, now, now);
      if (liveness.state === 'unknown') {
        refuse(409, 'liveness_unknown', 'Whether the target is in use could not be checked; try again');
      }
      if (liveness.state === 'alive') {
        refuse(409, 'target_alive', 'The target device is in use: it authenticated recently');
      }

      // The two confirmations of the dialog (§8), checked against the locked
      // rows and only after the access rule, so they are no hostname or OS
      // oracle for someone who may not reattach these devices.
      if (source.osType !== target.osType && input.acknowledgeOsChange !== true) {
        refuse(409, 'os_changed', `The new install reports ${source.osType}, the existing record ${target.osType}; confirm the operating system change`);
      }
      if (input.evidenceLevel === 'hint') {
        const typed = input.confirmTargetName?.trim() ?? '';
        if (!typed) refuse(400, 'confirm_target_name_required', 'Type the existing device\'s name to confirm the reattach');
        if (!sameHostname(typed, target.hostname)) {
          refuse(400, 'confirm_target_name_mismatch', 'The name typed does not match the existing device\'s name');
        }
      }

      // The step-up, last: every refusal above leaves the grant unspent. The
      // binding carries the target version just verified against the locked
      // row, so a grant minted for an install that has since re-enrolled
      // never matches.
      let stepUpGrantRef: string | null = null;
      if (stepUp.kind === 'grant') {
        const { grantId, auth, binding: epochs } = stepUp;
        if (!grantId) refuse(403, 'STEP_UP_REQUIRED', STEP_UP_REQUIRED_MESSAGE);
        const binding: StepUpGrantBinding = {
          userId: input.actor.userId,
          operation: 'device_reattach',
          authEpoch: epochs.authEpoch,
          mfaEpoch: epochs.mfaEpoch,
          sid: epochs.sid,
          resourceDigest: deviceReattachResourceDigest({
            sourceDeviceId: source.id,
            targetDeviceId: target.id,
            targetVersion: input.targetVersion,
            evidenceLevel: input.evidenceLevel,
            restoreDecommissioned: input.restoreDecommissioned,
          }),
        };
        const assured = await lockActorAssurance(tx, auth, binding)
          && await lockLiveUserSession(tx, { userId: input.actor.userId, sid: binding.sid });
        // Validate (GET) before consuming (GETDEL): a grant for another pair or
        // another install stays spendable for the one it was minted for.
        if (!assured || !(await validateStepUpGrant(grantId, binding))) {
          refuse(403, 'STEP_UP_REQUIRED', STEP_UP_REQUIRED_MESSAGE);
        }
        // F20: if the transaction fails after this, the grant is gone and the
        // technician steps up again.
        if (!(await consumeStepUpGrant(grantId, binding))) refuse(403, 'STEP_UP_REQUIRED', STEP_UP_REQUIRED_MESSAGE);
        stepUpGrantRef = grantId;
      }

      const [intent] = await tx
        .insert(deviceReattachIntents)
        .values({
          id: randomUUID(),
          partnerId,
          sourceDeviceId: source.id,
          targetDeviceId: target.id,
          state: 'requested',
          evidenceLevel: input.evidenceLevel,
          restoreDecommissioned: input.restoreDecommissioned,
          requestedBy: input.actor.userId,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + REATTACH_REQUESTED_TTL_MS),
          stepUpGrantRef,
          sourceAgentId: source.agentId,
          sourceOrgId: source.orgId,
          targetAgentId: target.agentId,
          targetIncarnation: target.installIncarnation,
          targetOrgId: target.orgId,
        })
        .returning();
      if (!intent) throw new Error('reattach intent was not written');
      return { intent, source, target };
    })));
  } catch (err) {
    if (err instanceof ReattachRefusedError) return err.refusal;
    // The partial unique indexes: a racing request that slipped past the
    // either-role check (it cannot, under the holding-area lock; backstop).
    if (isPgUniqueViolation(err)) {
      return reattachRefusal(409, 'device_in_open_intent', 'One of the devices is already in an open reattach');
    }
    throw err;
  }

  const { intent, source, target } = created;
  // The source's beats look for the directive only while this marker exists.
  if (!(await setReattachSourceMarker(intent.sourceDeviceId, intent.id, intent.expiresAt))) {
    console.error('[deviceReattach] the source marker could not be set; the source receives no rebind directive until it is', {
      intentId: intent.id,
      sourceDeviceId: intent.sourceDeviceId,
    });
  }
  await writeReattachAudit({
    action: 'device.reinstall.requested',
    actorUserId: input.actor.userId,
    targetOrgId: target.orgId,
    sourceOrgId: source.orgId,
    targetDeviceId: target.id,
    targetHostname: target.hostname,
    details: {
      intentId: intent.id,
      sourceDeviceId: source.id,
      sourceHostname: source.hostname,
      targetDeviceId: target.id,
      sourceParked: intent.sourceParked,
      evidenceLevel: intent.evidenceLevel,
      restoreDecommissioned: intent.restoreDecommissioned,
      targetIncarnation: intent.targetIncarnation,
      expiresAt: intent.expiresAt.toISOString(),
      stepUpGrantRecorded: Boolean(intent.stepUpGrantRef),
      stepUp: stepUp.kind === 'grant' ? 'grant' : 'not_required',
      acknowledgeOsChange: input.acknowledgeOsChange === true,
    },
  });
  return { ok: true, intent };
}

export type CancelReattachIntentResult =
  | { cancelled: true; intentId: string }
  | { cancelled: false; intentId: string; reason: 'not_found' | 'not_open'; state?: DeviceReattachIntent['state'] };

/**
 * Cancel an open intent: `admin` (a human), `source_changed` /
 * `target_changed` / `target_alive` / `restage_refused` (the protocol), or
 * `key_revoked` (deploy-key revocation; the parked-device incident action
 * calls it in-transaction through parkedExpiry). The staged agent, watchdog
 * and helper hashes are discarded, the confirmation hash is kept for the
 * typed answer, and the pending certificate is revoked after commit.
 */
export async function cancelReattachIntent(
  intentId: string,
  reason: ReattachCancelReason,
  options: { actorUserId?: string | null; now?: Date } = {},
): Promise<CancelReattachIntentResult> {
  const now = options.now ?? new Date();
  const outcome = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const intent = await readIntentForUpdate(tx, intentId);
    if (!intent) return { result: { cancelled: false, intentId, reason: 'not_found' } as const };
    const ended = await endIntentInTransaction(tx, intent, { state: 'cancelled', reason }, now);
    if (!ended) return { result: { cancelled: false, intentId, reason: 'not_open', state: intent.state } as const };
    return { result: { cancelled: true, intentId } as const, intent, ended };
  })));

  if ('ended' in outcome && outcome.ended && outcome.intent) {
    await clearReattachSourceMarker(outcome.intent.sourceDeviceId, outcome.intent.id);
    await revokeCertificatesAfterCommit(outcome.ended.revokeCertificateIds);
    await writeReattachAudit({
      action: 'device.reinstall.cancelled',
      actorUserId: options.actorUserId ?? null,
      targetOrgId: outcome.intent.targetOrgId,
      sourceOrgId: outcome.intent.sourceOrgId,
      targetDeviceId: outcome.intent.targetDeviceId,
      details: {
        intentId: outcome.intent.id,
        sourceDeviceId: outcome.intent.sourceDeviceId,
        cancelReason: reason,
        previousState: outcome.intent.state,
      },
    });
  }
  return outcome.result;
}
