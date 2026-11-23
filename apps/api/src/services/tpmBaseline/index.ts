/**
 * Reviewing a held TPM key change (#8318 wave T2, spec §12.2).
 *
 * T1 keeps a device's FIRST proven endorsement key as its baseline and holds
 * any different proven key in `tpm_ek_mismatch_*` for an operator. This is
 * that operator's decision, on one device:
 *  - `accept`: the held key becomes the baseline (`tpm_attested_at` is when
 *    it was proven), the hold is cleared. It changes what every later
 *    reattach compares against, so it needs the reattach access rule and a
 *    `device_tpm_baseline_accept` step-up while two-factor authentication is
 *    on;
 *  - `dismiss`: the hold is cleared and the baseline kept. No step-up: it
 *    keeps the anchor, and a device whose TPM really changed holds the new
 *    key again on its next proof.
 *
 * Who: the §8 reattach rule on that device (canActorActOnReattachEvidence):
 * a partner user with devices:write + devices:delete whose reachable orgs
 * include the device's; a parked device needs a full partner admin. A device
 * the user cannot reach (or whose site they cannot) is a 404.
 *
 * One system transaction:
 *  1. the device row FOR UPDATE (the tpm_* writers lock it first, so the key
 *     state read next cannot move; deviceReattach/evidence.ts);
 *  2. reachability, the live org, the access rule;
 *  3. the version the operator reviewed (version.ts): no hold, or another
 *     hold, is 409 `mismatch_changed`;
 *  4. an open reattach naming the device, read in system scope (a technician
 *     does not see every intent): 409 `reattach_in_progress`;
 *  5. accept only: the step-up, validated then consumed, last;
 *  6. the write and its audit row.
 * After an accept commits, the reinstall search runs for the new key
 * (reinstallCandidates.detectAfterKeyBaseline), off the response path.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, deviceHardware, users } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { CreateAuditLogParams } from '../auditService';
import { markRequestAuditWritten } from '../auditRequestTracking';
import { canActorActOnReattachEvidence, loadReattachActor, type ReattachAccessDenial } from '../deviceReattach/access';
import { reattachRefusal, ReattachRefusedError, type ReattachRefusal } from '../deviceReattach/errors';
import { anyDeviceInOpenIntent, lockReattachDevices } from '../deviceReattach/intentStore';
import { isReattachDeviceReachable } from '../deviceReattach/reachability';
import { isLiveOrg } from '../deviceReattach/revalidation';
import {
  consumeStepUpGrant,
  deviceTpmBaselineAcceptResourceDigest,
  validateStepUpGrant,
  type StepUpGrantBinding,
} from '../mfaStepUpGrant';
import { lockActorAssurance } from '../stepUpActorAssurance';
import { lockLiveUserSession } from '../unassignedPool/assignParkedDeviceSteps';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { tpmBaselineVersion, tpmBaselineVersionMatches } from './version';

export { TPM_BASELINE_VERSION_PATTERN } from './version';

export type TpmMismatchAction = 'accept' | 'dismiss';

export type TpmBaselineAuditAction = 'device.tpm_baseline.mismatch_accepted' | 'device.tpm_baseline.mismatch_dismissed';

/** The audit row of a review, built by the route from its request. */
export type TpmBaselineReviewAuditBuilder = (action: TpmBaselineAuditAction, orgId: string) => CreateAuditLogParams;

/** What GET /devices/:id/tpm-baseline returns. No key hash, ever. */
export interface TpmBaselineView {
  /** What the hardware report says (null: never reported). */
  tpmAvailable: boolean | null;
  /** A baseline key is recorded. */
  attested: boolean;
  /** When the baseline key was last proven. */
  attestedAt: string | null;
  /** A different proven key is held for review, with the version to review it by. */
  mismatch: { heldAt: string; version: string } | null;
}

/** The view of one device's key state; the caller has already checked it may read the device. */
export async function readTpmBaselineView(deviceId: string): Promise<TpmBaselineView> {
  const [row] = await db
    .select({
      tpmAvailable: deviceHardware.tpmAvailable,
      ek: deviceHardware.tpmEkPubSha256,
      attestedAt: deviceHardware.tpmAttestedAt,
      mismatch: deviceHardware.tpmEkMismatchSha256,
      mismatchAt: deviceHardware.tpmEkMismatchAt,
    })
    .from(deviceHardware)
    .where(eq(deviceHardware.deviceId, deviceId))
    .limit(1);
  return {
    tpmAvailable: row?.tpmAvailable ?? null,
    attested: Boolean(row?.ek),
    attestedAt: row?.attestedAt?.toISOString() ?? null,
    mismatch: row?.ek && row.mismatch && row.mismatchAt
      ? {
        heldAt: row.mismatchAt.toISOString(),
        version: tpmBaselineVersion({ deviceId, baselineSha256: row.ek, mismatchSha256: row.mismatch }),
      }
      : null,
  };
}

export type TpmReviewStepUp =
  | {
    kind: 'grant';
    grantId: string | null | undefined;
    auth: AuthContext;
    binding: Pick<StepUpGrantBinding, 'authEpoch' | 'mfaEpoch' | 'sid'>;
  }
  | { kind: 'not_required' };

export interface ReviewTpmMismatchInput {
  actor: { userId: string };
  deviceId: string;
  action: TpmMismatchAction;
  /** The version GET /tpm-baseline returned for the hold the operator reviewed. */
  version: string;
  /** The caller's site restriction (the device helpers' rule): false is a 404. */
  canAccessSite: (siteId: string) => boolean;
  /** Only read for `accept`. `not_required` only with two-factor authentication off. */
  stepUp: TpmReviewStepUp;
  audit: TpmBaselineReviewAuditBuilder;
  now?: Date;
}

export type ReviewTpmMismatchResult =
  | { ok: true; action: TpmMismatchAction; orgId: string }
  | ReattachRefusal;

const DENIAL_STATUS: Record<ReattachAccessDenial, 403 | 409> = {
  not_partner_user: 403,
  user_inactive: 403,
  partner_mismatch: 409,
  permission_denied: 403,
  org_access_denied: 403,
  full_admin_required: 403,
};

const DENIAL_MESSAGES: Record<ReattachAccessDenial, string> = {
  not_partner_user: 'Only a partner user can review a TPM key change',
  user_inactive: 'The requesting user is not active',
  partner_mismatch: 'The device is not in your partner',
  permission_denied: 'Reviewing a TPM key change needs devices:write and devices:delete',
  org_access_denied: 'You do not have access to this device\'s organization',
  full_admin_required: 'Reviewing a parked device\'s TPM key needs a full partner admin',
};

const DEVICE_NOT_FOUND = reattachRefusal(404, 'device_not_found', 'Device not found');
const STEP_UP_REQUIRED = reattachRefusal(403, 'STEP_UP_REQUIRED', 'Step-up required');

function refuse(refusal: ReattachRefusal): never {
  throw new ReattachRefusedError(refusal);
}

export async function reviewTpmKeyMismatch(input: ReviewTpmMismatchInput): Promise<ReviewTpmMismatchResult> {
  const now = input.now ?? new Date();
  if (input.action !== 'accept' && input.action !== 'dismiss') {
    return reattachRefusal(400, 'invalid_action', 'Unknown action');
  }
  // Fail closed, as the reattach request: neither a grant nor an explicit
  // "not required" is a missing grant.
  const stepUp = input.stepUp as TpmReviewStepUp | null | undefined;
  if (input.action === 'accept' && (!stepUp || (stepUp.kind !== 'grant' && stepUp.kind !== 'not_required'))) {
    return STEP_UP_REQUIRED;
  }
  if (stepUp?.kind === 'grant' && stepUp.auth.user.id !== input.actor.userId) {
    throw new Error('reviewTpmKeyMismatch: the step-up actor is not the requester');
  }

  let orgId: string;
  try {
    orgId = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const [user] = await tx
        .select({ partnerId: users.partnerId })
        .from(users)
        .where(eq(users.id, input.actor.userId))
        .limit(1);
      if (!user?.partnerId) refuse(reattachRefusal(403, 'not_partner_user', DENIAL_MESSAGES.not_partner_user));
      const partnerId = user.partnerId;

      const device = (await lockReattachDevices(tx, [input.deviceId, input.deviceId], 'update')).get(input.deviceId);
      const actor = await loadReattachActor(tx, input.actor.userId, partnerId);
      const parked = device ? isUnassignedPoolOrgType(device.orgType) : false;
      // Out of reach (another partner, an org or site not theirs) reads as
      // missing. A parked device is reachable as a reattach source is.
      if (
        !device
        || !isReattachDeviceReachable(actor, partnerId, device, parked ? 'source' : 'target')
        || !input.canAccessSite(device.siteId)
      ) {
        refuse(DEVICE_NOT_FOUND);
      }
      if (!isLiveOrg(device)) refuse(reattachRefusal(409, 'org_draining', 'The device\'s organization is not active'));
      const access = canActorActOnReattachEvidence(actor, { partnerId, orgId: device.orgId, parked });
      if (!access.allowed) refuse(reattachRefusal(DENIAL_STATUS[access.code], access.code, DENIAL_MESSAGES[access.code]));

      const [hw] = await tx
        .select({ ek: deviceHardware.tpmEkPubSha256, mismatch: deviceHardware.tpmEkMismatchSha256, mismatchAt: deviceHardware.tpmEkMismatchAt })
        .from(deviceHardware)
        .where(eq(deviceHardware.deviceId, device.id))
        .limit(1);
      if (
        !hw?.ek || !hw.mismatch || !hw.mismatchAt
        || !tpmBaselineVersionMatches(input.version, { deviceId: device.id, baselineSha256: hw.ek, mismatchSha256: hw.mismatch })
      ) {
        refuse(reattachRefusal(409, 'mismatch_changed', 'The TPM key state changed since it was shown; reload and try again'));
      }
      // The key a reattach compares against must not move under an open one.
      if (await anyDeviceInOpenIntent(tx, [device.id])) {
        refuse(reattachRefusal(409, 'reattach_in_progress', 'The device is in an open reattach; finish or cancel it first'));
      }

      if (input.action === 'accept' && stepUp?.kind === 'grant') {
        const { grantId, auth, binding: epochs } = stepUp;
        if (!grantId) refuse(STEP_UP_REQUIRED);
        const binding: StepUpGrantBinding = {
          userId: input.actor.userId,
          operation: 'device_tpm_baseline_accept',
          authEpoch: epochs.authEpoch,
          mfaEpoch: epochs.mfaEpoch,
          sid: epochs.sid,
          resourceDigest: deviceTpmBaselineAcceptResourceDigest({ deviceId: device.id, baselineVersion: input.version }),
        };
        const assured = await lockActorAssurance(tx, auth, binding)
          && await lockLiveUserSession(tx, { userId: input.actor.userId, sid: binding.sid });
        if (!assured || !(await validateStepUpGrant(grantId, binding))) refuse(STEP_UP_REQUIRED);
        if (!(await consumeStepUpGrant(grantId, binding))) refuse(STEP_UP_REQUIRED);
      }

      await tx
        .update(deviceHardware)
        .set(input.action === 'accept'
          ? { tpmEkPubSha256: hw.mismatch, tpmAttestedAt: hw.mismatchAt, tpmEkMismatchSha256: null, tpmEkMismatchAt: null, updatedAt: now }
          : { tpmEkMismatchSha256: null, tpmEkMismatchAt: null, updatedAt: now })
        .where(eq(deviceHardware.deviceId, device.id));

      const { actorType = 'user', partnerId: _partnerId, trigger: _trigger, ...row } = input.audit(
        input.action === 'accept' ? 'device.tpm_baseline.mismatch_accepted' : 'device.tpm_baseline.mismatch_dismissed',
        device.orgId,
      );
      await tx.insert(auditLogs).values({ actorType, ...row, orgId: device.orgId, partnerId: null });
      return device.orgId;
    })));
  } catch (err) {
    if (err instanceof ReattachRefusedError) return err.refusal;
    throw err;
  }
  markRequestAuditWritten();
  return { ok: true, action: input.action, orgId };
}
