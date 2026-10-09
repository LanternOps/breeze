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
 *   - a snapshot taken before attestations existed (`unattested_legacy`),
 *     requested by a user who has no second factor to step up with: the 403
 *     names `method: 'typed'` and the phrase to type (the target device's
 *     name). POST /backup/restore-confirmations checks the typed phrase and
 *     mints a single-use grant for operation `backup_unattested_restore_typed`,
 *     bound exactly like the two-factor grant; it is consumed and recorded
 *     here the same way. A user with a second factor always gets the
 *     two-factor step-up, and every other reason (`unattested`, a device-local
 *     snapshot restored onto another device) needs it too.
 *   - a caller without an interactive user session (API key, MCP token) can
 *     never confirm one: 409 `snapshot_integrity_unavailable`.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { devices } from '../../db/schema/devices';
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
import { restoreTargetRefusal } from '../../services/restoreTargetReadiness';
import { userIsMfaProtected } from '../auth/helpers';
import { ENABLE_2FA } from '../auth/schemas';

export const UNATTESTED_RESTORE_STEP_UP_OPERATION = 'backup_unattested_restore' as const;
/** Grant operation minted by POST /backup/restore-confirmations (typed confirmation). */
export const UNATTESTED_RESTORE_TYPED_OPERATION = 'backup_unattested_restore_typed' as const;

/**
 * How the operator confirms a restore that needs it: a two-factor step-up
 * (`mfa`), typing the target device's name (`typed`, users without a second
 * factor, snapshots taken before attestations existed), or an explicit
 * confirmation on a deployment running without two-factor authentication
 * (`confirm`).
 */
export type RestoreConfirmationMethod = 'mfa' | 'typed' | 'confirm';

/** The only reason a typed confirmation can stand in for the two-factor step-up. */
export function typedConfirmationAllowedFor(reason: RestoreAuthorizationReason): boolean {
  return reason === 'unattested_legacy';
}

/**
 * Whether the user has a factor to step up with. A failed lookup answers
 * true, so the user is asked for the two-factor step-up rather than offered
 * the typed confirmation.
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

/** The phrase a typed confirmation must match: the target device's display name, else its hostname. */
export async function restoreConfirmationPhrase(orgId: string, targetDeviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ displayName: devices.displayName, hostname: devices.hostname })
    .from(devices)
    .where(and(eq(devices.id, targetDeviceId), eq(devices.orgId, orgId)))
    .limit(1);
  const phrase = row?.displayName?.trim() || row?.hostname?.trim() || '';
  return phrase || null;
}

/** Case-insensitive, surrounding whitespace ignored. */
export function typedConfirmationMatches(phrase: string, typed: string): boolean {
  return typed.trim().toLowerCase() === phrase.trim().toLowerCase();
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

  let method: RestoreConfirmationMethod = 'mfa';
  let phrase: string | null = null;
  if (!ENABLE_2FA) {
    method = 'confirm';
  } else if (typedConfirmationAllowedFor(decision.reason) && !(await userCanStepUp(userId!, req.userMfaProtected))) {
    phrase = await restoreConfirmationPhrase(req.orgId, req.targetDeviceId);
    // Without a phrase there is nothing to type: the two-factor step-up is the only way.
    if (phrase) method = 'typed';
  }

  const stepUpRequired = (): RestoreIntegrityCheck => ({
    ok: false,
    status: 403,
    body: {
      error: decision.reason === 'producer_only_other_target'
        ? RESTORE_INTEGRITY_MESSAGES.producer_only_other_target
        : method === 'typed'
          ? RESTORE_INTEGRITY_MESSAGES.typed_confirmation_required
          : RESTORE_INTEGRITY_MESSAGES.step_up_required,
      code: 'STEP_UP_REQUIRED',
      stepUp: {
        operation: UNATTESTED_RESTORE_STEP_UP_OPERATION,
        method,
        reason: decision.reason,
        resource: { snapshotId: req.snapshotDbId, targetDeviceId: req.targetDeviceId, commandType: req.commandType },
        ...(method === 'typed' ? { confirmation: { phrase, orgId: req.orgId } } : {}),
      },
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
  // The operation follows the method: a typed-confirmation grant is never
  // accepted from a user who has a second factor, and the reverse.
  const consumed = await consumeStepUpGrant(req.stepUpGrant, {
    userId: userId!,
    operation: method === 'typed' ? UNATTESTED_RESTORE_TYPED_OPERATION : UNATTESTED_RESTORE_STEP_UP_OPERATION,
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
