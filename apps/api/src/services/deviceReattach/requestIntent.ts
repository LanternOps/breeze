/**
 * Creating and cancelling reattach intents (#8318 wave 1b, spec §4.3, §6.5,
 * §8).
 *
 * `requestDeviceReattach` is what the wave 2 route (`POST /devices/:sourceId/
 * reattach`, with its step-up and dialog) will call. In wave 1b NO HTTP route
 * creates an intent: the feature stays dark in production and the tests drive
 * the service directly. It accepts an optional `stepUpGrantRef` and only
 * stores it (on the intent, then the ledger); the step-up itself is wave 2.
 *
 * Everything runs in ONE system transaction (the conflict and eligibility
 * checks must see every intent and the ledger, which a technician's context
 * cannot):
 *   1. the partner's holding-area advisory lock, unconditionally (every intent
 *      creation takes it, which makes "a device is in at most one open intent
 *      in either role" race-free; the partial unique indexes are the
 *      backstop);
 *   2. both device rows FOR UPDATE, ascending id order;
 *   3. the refusals of §8, then the insert of the `requested` intent with the
 *      versions the human authorized and `expires_at = now + 60 min`.
 * Audit `device.reinstall.requested` in both orgs after commit.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceReattachIntents, users, type DeviceReattachEvidenceLevel, type DeviceReattachIntent } from '../../db/schema';
import { lockPartnerHoldingArea } from '../unassignedPool/holdingAreaLock';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
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
import { REATTACH_REQUESTED_TTL_MS, type ReattachCancelReason } from './protocol';

/** Org statuses a reattach may touch: the same set parked assignment accepts. */
const ACTIVE_ORG_STATUSES = new Set(['active', 'trial']);
/** Org types a TARGET can never live in (a reattach target is a managed record). */
const NON_TARGET_ORG_TYPES = new Set(['unassigned_pool', 'quick_support']);

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
  /** The wave 2 step-up grant id; stored only (on the intent and the ledger). */
  stepUpGrantRef?: string | null;
  /** Test seam. */
  now?: Date;
}

export type RequestDeviceReattachResult =
  | { ok: true; intent: DeviceReattachIntent }
  | ReattachRefusal;

function refuse(status: ReattachRefusal['status'], code: string, message: string): never {
  throw new ReattachRefusedError(reattachRefusal(status, code, message));
}

function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth += 1) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** The device-side refusals shared by both roles. */
function refuseUnhealthy(device: LockedReattachDevice, role: 'source' | 'target'): void {
  if (device.status === 'quarantined') refuse(409, 'device_quarantined', `The ${role} device is quarantined`);
  if (device.agentTokenSuspendedAt) refuse(409, 'device_suspended', `The ${role} device's agent credentials are suspended`);
  if (!ACTIVE_ORG_STATUSES.has(device.orgStatus) || device.orgDeletedAt) {
    refuse(409, 'org_draining', `The ${role} device's organization is not active`);
  }
}

export async function requestDeviceReattach(input: RequestDeviceReattachInput): Promise<RequestDeviceReattachResult> {
  const now = input.now ?? new Date();
  if (input.sourceDeviceId === input.targetDeviceId) {
    return reattachRefusal(400, 'same_device', 'A device cannot be reattached onto itself');
  }
  if (input.evidenceLevel !== 'hint' && input.evidenceLevel !== 'tpm_continuity') {
    return reattachRefusal(400, 'invalid_evidence_level', 'Unknown evidence level');
  }

  let created: { intent: DeviceReattachIntent; source: LockedReattachDevice; target: LockedReattachDevice };
  try {
    created = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const [user] = await tx
        .select({ partnerId: users.partnerId })
        .from(users)
        .where(eq(users.id, input.actor.userId))
        .limit(1);
      if (!user) refuse(403, 'not_partner_user', ACCESS_DENIAL_MESSAGES.not_partner_user);
      const partnerId = user.partnerId;

      await lockPartnerHoldingArea(tx, partnerId);
      const locked = await lockReattachDevices(tx, [input.sourceDeviceId, input.targetDeviceId], 'update');
      const source = locked.get(input.sourceDeviceId);
      const target = locked.get(input.targetDeviceId);
      if (!source || !target) refuse(404, 'device_not_found', 'Device not found');

      // One partner: the requester's, the source's and the target's (§8).
      if (source.orgPartnerId !== partnerId || target.orgPartnerId !== partnerId) {
        refuse(409, 'partner_mismatch', ACCESS_DENIAL_MESSAGES.partner_mismatch);
      }
      const sourceParked = isUnassignedPoolOrgType(source.orgType);

      const access = canActorReattach(await loadReattachActor(tx, input.actor.userId, partnerId), {
        partnerId,
        sourceOrgId: source.orgId,
        sourceParked,
        targetOrgId: target.orgId,
      });
      if (!access.allowed) {
        refuse(ACCESS_DENIAL_STATUS[access.code], access.code, ACCESS_DENIAL_MESSAGES[access.code]);
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
      if (NON_TARGET_ORG_TYPES.has(target.orgType)) {
        refuse(409, 'target_ineligible', 'The target device is not a managed record');
      }
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
          stepUpGrantRef: input.stepUpGrantRef ?? null,
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
    if (isUniqueViolation(err)) {
      return reattachRefusal(409, 'device_in_open_intent', 'One of the devices is already in an open reattach');
    }
    throw err;
  }

  const { intent, source, target } = created;
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
