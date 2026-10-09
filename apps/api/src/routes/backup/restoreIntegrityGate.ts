/**
 * Request-time integrity check for restore routes (services/backupRestoreGate.ts).
 *
 * Called by every route that starts a privileged restore, after the route's
 * own validation and right before it creates anything. Delivery and recovery
 * authentication enforce the same rules again; this is where the operator
 * gets an immediate, actionable answer and where a step-up is consumed.
 *
 *   - attested snapshot (or device-local onto its own device), or read-only
 *     validation: allowed, nothing to record.
 *   - attestation still being checked, snapshot failed its check, snapshot
 *     not resolvable: 409 with a `code` and an operator-facing message.
 *   - no usable attestation: 403 `STEP_UP_REQUIRED` naming the exact
 *     step-up to obtain (operation `backup_unattested_restore` and the
 *     resource it must be bound to). With a matching grant (consumed here,
 *     single-use) the route proceeds and must record the authorization bound
 *     to what it creates (`recordRequestAuthorization`). On a deployment that
 *     runs with two-factor authentication disabled, an explicit
 *     `confirmUnattestedRestore: true` stands in for the grant; the
 *     authorization and its audit event are recorded the same way.
 *   - the same, requested by a user who has no second factor to step up
 *     with (two-factor authentication enabled): 403 `MFA_ENROLLMENT_REQUIRED`
 *     with `stepUp.method: 'enrol'` and the same operation and resource, so
 *     the client can resume with the step-up once a factor is enrolled.
 *     Nothing is consumed or recorded. If the factor lookup fails, the
 *     two-factor step-up is asked for instead.
 *   - a caller without an interactive user session (API key, MCP token) can
 *     never confirm one: 409 `snapshot_integrity_unavailable`.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { getUserEpochs } from '../../services/authEpochs';
import {
  RESTORE_INTEGRITY_MESSAGES,
  decideRestoreGate,
  gateForActor,
  type RestoreAuthorizationReason,
} from '../../services/backupRestoreGate';
import {
  recordRestoreAuthorization,
  type RestoreAuthorizationBinding,
  type RestoreConfirmationMethod,
} from '../../services/backupRestoreAuthorization';
import { resolveRestoreIntegrity } from '../../services/backupRestoreIntegrity';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { consumeStepUpGrant, unattestedRestoreResourceDigest } from '../../services/mfaStepUpGrant';
import { restoreTargetRefusal } from '../../services/restoreTargetReadiness';
import { userIsMfaProtected } from '../auth/helpers';
import { ENABLE_2FA } from '../auth/schemas';

export const UNATTESTED_RESTORE_STEP_UP_OPERATION = 'backup_unattested_restore' as const;

/** Answer code for a user who must enrol a second factor before confirming a restore. */
export const MFA_ENROLLMENT_REQUIRED_CODE = 'MFA_ENROLLMENT_REQUIRED' as const;

/**
 * Whether the user has a factor to step up with. A failed lookup answers
 * true, so the user is asked for the two-factor step-up rather than told to
 * enrol a factor they may already have.
 */
export async function userCanStepUp(userId: string, prefetched?: boolean): Promise<boolean> {
  if (prefetched !== undefined) return prefetched;
  try {
    return await userIsMfaProtected(userId);
  } catch (err) {
    console.error('[restoreIntegrityGate] factor lookup failed; asking for the two-factor step-up:', err);
    return true;
  }
}

export type RestoreIntegrityRequest = {
  orgId: string;
  snapshotDbId: string;
  targetDeviceId: string;
  commandType: string;
  /** Step-up grant id from POST /auth/mfa/step-up (operation backup_unattested_restore). */
  stepUpGrant?: string;
  /** Only honoured while two-factor authentication is disabled on the deployment. */
  confirmUnattestedRestore?: boolean;
  /**
   * The user's epochs, read by the caller in the request's own DB context.
   * Required when the check runs inside a narrower org-scoped transaction,
   * which cannot see a partner-level user's row.
   */
  userEpochs?: { authEpoch: number; mfaEpoch: number } | null;
  /**
   * Whether the user has a second factor, read by the caller in the request's
   * own DB context, for the same reason as `userEpochs`.
   */
  userMfaProtected?: boolean;
  /**
   * The device that will run the restore command (the target, or the rebuild
   * host). When set, a restore that needs confirmation is refused BEFORE the
   * step-up is consumed if that device is offline or its helper does not
   * check attestations, so a restore the enqueue path would refuse burns no
   * grant and records no authorization. Omitted for recovery tokens and
   * recoveries, which run no device command.
   */
  executingDeviceId?: string;
};

export type RestoreIntegrityCheck =
  | { ok: true; authorizationReason: null }
  | { ok: true; authorizationReason: RestoreAuthorizationReason; confirmationMethod: RestoreConfirmationMethod }
  | { ok: false; status: 403 | 409; body: Record<string, unknown> };

type AuthLike = {
  user?: { id: string; email?: string | null } | null;
  token?: { sid?: string | null } | null;
};

/**
 * Decides whether the restore may be requested. When the result carries an
 * `authorizationReason`, a step-up was consumed (or confirmed) and the route
 * MUST call `recordRequestAuthorization` bound to what it creates before the
 * restore can run.
 */
export async function checkRestoreIntegrityRequest(
  c: Context,
  req: RestoreIntegrityRequest,
): Promise<RestoreIntegrityCheck> {
  const auth = c.get('auth') as AuthLike | undefined;
  const userId = auth?.user?.id ?? null;
  const sid = auth?.token?.sid ?? null;
  const interactive = !!userId && !!sid;

  const integrity = await resolveRestoreIntegrity(req.snapshotDbId);
  const decision = gateForActor(
    decideRestoreGate({ commandType: req.commandType, integrity, targetDeviceId: req.targetDeviceId }),
    interactive ? 'user' : 'system',
  );
  if (decision.kind === 'allow') return { ok: true, authorizationReason: null };
  if (decision.kind === 'refuse') {
    return { ok: false, status: 409, body: { error: decision.message, code: decision.code } };
  }

  if (req.executingDeviceId) {
    const notReady = await restoreTargetRefusal(req.executingDeviceId, req.commandType);
    if (notReady) return { ok: false, status: 409, body: { error: notReady.message, code: notReady.code } };
  }

  const method: RestoreConfirmationMethod = ENABLE_2FA ? 'mfa' : 'confirm';
  const resource = { snapshotId: req.snapshotDbId, targetDeviceId: req.targetDeviceId, commandType: req.commandType };

  // Only a proven second factor confirms a restore while two-factor
  // authentication is enabled: a user without one is told to enrol one, with
  // the step-up to resume with once they have. Nothing is consumed.
  if (method === 'mfa' && !(await userCanStepUp(userId!, req.userMfaProtected))) {
    return {
      ok: false,
      status: 403,
      body: {
        error: RESTORE_INTEGRITY_MESSAGES.mfa_enrollment_required,
        code: MFA_ENROLLMENT_REQUIRED_CODE,
        stepUp: { operation: UNATTESTED_RESTORE_STEP_UP_OPERATION, method: 'enrol', reason: decision.reason, resource },
      },
    };
  }

  const stepUpRequired = (): RestoreIntegrityCheck => ({
    ok: false,
    status: 403,
    body: {
      error: decision.reason === 'producer_only_other_target'
        ? RESTORE_INTEGRITY_MESSAGES.producer_only_other_target
        : RESTORE_INTEGRITY_MESSAGES.step_up_required,
      code: 'STEP_UP_REQUIRED',
      stepUp: { operation: UNATTESTED_RESTORE_STEP_UP_OPERATION, method, reason: decision.reason, resource },
    },
  });
  const authorized = (): RestoreIntegrityCheck => ({ ok: true, authorizationReason: decision.reason, confirmationMethod: method });

  if (method === 'confirm') {
    // The deployment runs without two-factor authentication: the operator
    // must still confirm explicitly, and the confirmation is recorded.
    return req.confirmUnattestedRestore === true ? authorized() : stepUpRequired();
  }

  if (!req.stepUpGrant) return stepUpRequired();
  const epochs = req.userEpochs !== undefined ? req.userEpochs : await getUserEpochs(userId!);
  if (!epochs) return stepUpRequired();
  // Missing, stale, replayed and mismatched grants are one answer on purpose.
  const consumed = await consumeStepUpGrant(req.stepUpGrant, {
    userId: userId!,
    operation: UNATTESTED_RESTORE_STEP_UP_OPERATION,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid: sid!,
    resourceDigest: unattestedRestoreResourceDigest({
      snapshotDbId: req.snapshotDbId,
      targetDeviceId: req.targetDeviceId,
      commandType: req.commandType,
    }),
  });
  return consumed ? authorized() : stepUpRequired();
}

/**
 * Records the authorization (and its audit event, atomically) for a restore
 * whose check returned an `authorizationReason`.
 *
 * `inCurrentTransaction: false` (the default, for device commands) commits it
 * in its own org-scoped transaction before returning, so the command it is
 * bound to can be delivered the moment it is queued. Pass true to write it in
 * the request's transaction alongside the row it is bound to (a recovery
 * token or recovery inserted by the same request).
 */
export async function recordRequestAuthorization(
  c: Context,
  req: RestoreIntegrityRequest,
  reason: RestoreAuthorizationReason,
  binding: RestoreAuthorizationBinding,
  options: { inCurrentTransaction?: boolean; confirmationMethod?: RestoreConfirmationMethod } = {},
): Promise<string> {
  const auth = c.get('auth') as AuthLike | undefined;
  const record = () => recordRestoreAuthorization({
    orgId: req.orgId,
    snapshotDbId: req.snapshotDbId,
    targetDeviceId: req.targetDeviceId,
    commandType: req.commandType,
    reason,
    userId: auth!.user!.id,
    userEmail: auth?.user?.email ?? null,
    binding,
    ...(options.confirmationMethod ? { confirmationMethod: options.confirmationMethod } : {}),
    ipAddress: getTrustedClientIpOrUndefined(c) ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  });
  if (options.inCurrentTransaction) return record();
  return runOutsideDbContext(() =>
    withDbAccessContext(
      { scope: 'organization', orgId: req.orgId, accessibleOrgIds: [req.orgId], label: 'restoreIntegrityGate.record' },
      record,
    ),
  );
}

/**
 * For a route that queues one device command: checks the request and, for a
 * confirmed restore, reserves the command id and records its authorization
 * (committed before returning). The route queues the command with that id.
 */
export async function gateRestoreCommand(
  c: Context,
  req: RestoreIntegrityRequest,
): Promise<{ ok: true; commandId?: string } | Extract<RestoreIntegrityCheck, { ok: false }>> {
  const check = await checkRestoreIntegrityRequest(c, req);
  if (!check.ok) return check;
  if (!check.authorizationReason) return { ok: true };
  const commandId = randomUUID();
  await recordRequestAuthorization(c, req, check.authorizationReason, { commandId }, { confirmationMethod: check.confirmationMethod });
  return { ok: true, commandId };
}

/** The 4xx a route answers with when the check refused. */
export function restoreIntegrityResponse(c: Context, check: Extract<RestoreIntegrityCheck, { ok: false }>) {
  return c.json(check.body, check.status);
}
