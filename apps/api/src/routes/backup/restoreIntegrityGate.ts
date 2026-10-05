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
import { recordRestoreAuthorization, type RestoreAuthorizationBinding } from '../../services/backupRestoreAuthorization';
import { resolveRestoreIntegrity } from '../../services/backupRestoreIntegrity';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { consumeStepUpGrant, unattestedRestoreResourceDigest } from '../../services/mfaStepUpGrant';
import { ENABLE_2FA } from '../auth/schemas';

export const UNATTESTED_RESTORE_STEP_UP_OPERATION = 'backup_unattested_restore';

export type RestoreIntegrityRequest = {
  orgId: string;
  snapshotDbId: string;
  targetDeviceId: string;
  commandType: string;
  /** Step-up grant id from POST /auth/mfa/step-up (operation backup_unattested_restore). */
  stepUpGrant?: string;
  /** Only honoured while two-factor authentication is disabled on the deployment. */
  confirmUnattestedRestore?: boolean;
};

export type RestoreIntegrityCheck =
  | { ok: true; authorizationReason: RestoreAuthorizationReason | null }
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

  const stepUpRequired = (): RestoreIntegrityCheck => ({
    ok: false,
    status: 403,
    body: {
      error: decision.reason === 'producer_only_other_target'
        ? RESTORE_INTEGRITY_MESSAGES.producer_only_other_target
        : RESTORE_INTEGRITY_MESSAGES.step_up_required,
      code: 'STEP_UP_REQUIRED',
      stepUp: {
        operation: UNATTESTED_RESTORE_STEP_UP_OPERATION,
        method: ENABLE_2FA ? 'mfa' : 'confirm',
        reason: decision.reason,
        resource: { snapshotId: req.snapshotDbId, targetDeviceId: req.targetDeviceId, commandType: req.commandType },
      },
    },
  });

  if (!ENABLE_2FA) {
    // The deployment runs without two-factor authentication: the operator
    // must still confirm explicitly, and the confirmation is recorded.
    return req.confirmUnattestedRestore === true ? { ok: true, authorizationReason: decision.reason } : stepUpRequired();
  }

  if (!req.stepUpGrant) return stepUpRequired();
  const epochs = await getUserEpochs(userId!);
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
  return consumed ? { ok: true, authorizationReason: decision.reason } : stepUpRequired();
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
  options: { inCurrentTransaction?: boolean } = {},
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
  await recordRequestAuthorization(c, req, check.authorizationReason, { commandId });
  return { ok: true, commandId };
}

/** The 4xx a route answers with when the check refused. */
export function restoreIntegrityResponse(c: Context, check: Extract<RestoreIntegrityCheck, { ok: false }>) {
  return c.json(check.body, check.status);
}
