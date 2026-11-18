import { Hono, type Context } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  consumeMFAToken,
  generateRecoveryCodes,
  getRedis,
  beginAuthIssuance,
  cancelAuthIssuance,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  bindIssuedUserSession,
  completeAdditionalMfaFactorEnrollment,
  completeInitialMfaEnrollment,
  completeMfaFactorRemoval,
  type AuthIssuanceCapability,
  type AuthorizedUserSession,
} from '../../services';
import { carryForwardBinding, readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { captureException } from '../../services/sentry';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import { ENABLE_2FA } from './schemas';
import {
  consumeFactorManagementReauthGrant,
  encryptMfaSecret,
  enforceExistingFactorStepUp,
  hashRecoveryCodes,
  installAuthorizedUserSessionCookies,
  mfaDisabledResponse,
  MFA_CODE_INVALID,
  rejectProof,
  resolveEnrollmentStepUp,
  resolveFactorManagementStepUp,
  resolveUserAuditOrgId,
  runWithSystemDbAccess,
  toPublicTokens,
  writeAuthAudit,
} from './helpers';
import { activeTotpFactorSql, canAddBackupTotp, hasActiveTotpFactor } from './mfaFactorPredicates';
import { installAuthBindingReplacement, requestAuthBinding } from './binding';

const { db, withSystemDbAccessContext, runOutsideDbContext } = dbModule;

/**
 * #4470: a rejected proof on these routes answers 400, never 401 — the bearer
 * that authenticated the request is still valid, and a 401 makes the web
 * client refresh-and-replay into a sign-out. Same value as mfa.ts's
 * MFA_PROOF_REJECTION_STATUS (not imported: mfa.ts imports this module).
 */
const TOTP_PROOF_REJECTION_STATUS = 400;

const SETUP_KEY = (userId: string) => `mfa:setup:${userId}`;
const SETUP_EXPIRED_MESSAGE = 'MFA setup expired. Please start setup again.';

/**
 * Delete the setup record only if it still holds what this request read. A
 * newer `/mfa/setup` from the same account may have replaced it in between,
 * and that one belongs to whoever started it. Best-effort: the factor write
 * advanced `mfa_epoch`, so the record we read can no longer satisfy the epoch
 * binding of any later token anyway.
 */
const RELEASE_SETUP_IF_UNCHANGED =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Which factor write a TOTP confirmation performs. */
export type TotpSetupRole = 'initial' | 'backup';

/**
 * The Redis record `/mfa/setup` stages for its confirmation. Bound to the
 * authenticated epochs (an admin reset or factor change kills it), to the
 * session that staged it (`sid`, so another session of the same account
 * cannot confirm it), and to the role it was staged for.
 */
export interface TotpSetupRecord {
  secret: string;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
  role: TotpSetupRole;
}

export function serializeTotpSetupRecord(record: TotpSetupRecord): string {
  return JSON.stringify(record);
}

/** The role an account's live row stages a TOTP setup for, or null if none. */
export function totpSetupRoleFor(row: Parameters<typeof canAddBackupTotp>[0]): TotpSetupRole | null {
  if (row.mfaEnabled !== true) return 'initial';
  return canAddBackupTotp(row) ? 'backup' : null;
}

export async function enforceTotpEnrollmentPolicy(c: Context, auth: AuthContext): Promise<Response | null> {
  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  }, { failClosed: true, failClosedMethods: true });
  if (!policy.allowedMethods.totp) {
    return c.json({ error: 'Your organization does not allow authenticator-app MFA' }, 403);
  }
  return null;
}

function authIssuanceAdmissionError(
  c: Context,
  error: unknown,
  { stepUpGrantConsumed = false }: { stepUpGrantConsumed?: boolean } = {},
): Response | null {
  const consumedGrant = stepUpGrantConsumed ? { stepUpGrantConsumed: true } : {};
  if (error instanceof AuthBindingRotationRequiredError) {
    installAuthBindingReplacement(c, error.replacement);
    return c.json({ error: error.message, reason: 'auth_binding_rotation_required', ...consumedGrant }, 428);
  }
  if (
    error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError
  ) {
    return c.json({ error: 'Authentication issuance unavailable', ...consumedGrant }, 409);
  }
  return null;
}

/**
 * Re-emit `response` with `stepUpGrantConsumed: true` merged into its JSON
 * body. Every failure after a single-use grant was spent says so, because a
 * Redis consume cannot roll back with Postgres and the client must drop the
 * cached grant rather than present it again.
 */
async function withGrantConsumed(response: Response): Promise<Response> {
  const body = await response.clone().json().catch(() => ({}));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify({ ...body, stepUpGrantConsumed: true }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * POST-COMMIT session install. The factor write is committed and every other
 * session is already dead, so a failure here is reported and stepped over;
 * the caller withholds the tokens (the refresh JTI was never bound).
 */
async function installReplacementSession(
  c: Context,
  issued: AuthorizedUserSession,
  userId: string,
  factorChange: string,
): Promise<boolean> {
  try {
    await bindIssuedUserSession(issued);
    installAuthorizedUserSessionCookies(c, issued);
    return true;
  } catch (error) {
    captureException(error, c, { factorChange });
    console.error('[auth] authenticator-app factor write committed but the replacement session could not be installed', {
      userId,
      factorChange,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function setupError(c: Context, message: string, status: 400 | 500 | 503): Response {
  return c.json({ error: message, message }, status);
}

function factorStateChanged(c: Context, stepUpGrantConsumed: boolean): Response {
  const message = 'Your sign-in methods changed while this was in progress. Please start again.';
  return c.json({ error: message, message, code: 'factor_state_changed', stepUpGrantConsumed }, 409);
}

async function releaseSetupRecord(userId: string, raw: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.eval(RELEASE_SETUP_IF_UNCHANGED, 1, SETUP_KEY(userId), raw);
  } catch (error) {
    console.warn('[auth] could not release the MFA setup record', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ConfirmTotpEnrollmentInput {
  code: string;
  currentPassword?: string;
  ssoReauthGrantId?: string;
  stepUpGrantId?: string;
  /**
   * True for `/mfa/verify` setup-confirm, whose "user at the keyboard" gate is
   * `/mfa/setup` itself (it carries no password field). False for
   * `/mfa/enable`, which re-proves the password here.
   */
  passwordAlreadyProven: boolean;
}

/**
 * The confirmation half of `/mfa/setup`, shared by `/mfa/enable` and
 * `/mfa/verify` setup-confirm. Installs the staged secret as either the
 * account's FIRST factor (initial: codes minted, TOTP primary) or as the
 * BACKUP beside a primary passkey (#10650: no code change, primary untouched).
 *
 * The order is fixed:
 *  1. read the setup record (epochs, `sid`, role)
 *  2. validate the enrollment proof (password or SSO grant)
 *  3. validate the `add_factor` grant (no-op on an unprotected account)
 *  4. live policy must allow TOTP
 *  5. consume the TOTP code (single-use time step)
 *  6. read the live row and confirm the staged role still applies
 *  7. reserve issuance
 *  8. spend the `add_factor` grant, then the enrollment grant
 *  9. the guarded factor write, inside the session-replacement transaction
 * 10. install the replacement session, audit, release the setup record
 *
 * Validating before the code (2–3) means a missing or stale grant does not
 * burn the time step; spending after the code (8) means a mistyped code does
 * not burn the grant. Reserving issuance before spending (7) keeps a refused
 * admission from costing the user a grant.
 *
 * I3: `/mfa/verify` case 2 has NO ambient DB access context (its inline
 * `authMiddleware(c, async () => {})` tears the context down). Every read here
 * goes through a helper that establishes system context, and both writes run
 * inside the session-replacement primitives — never a bare `db.update`.
 */
export async function confirmTotpEnrollment(
  c: Context,
  auth: AuthContext,
  input: ConfirmTotpEnrollmentInput,
): Promise<Response> {
  const userId = auth.user.id;

  // 1. Setup record.
  const redis = getRedis();
  if (!redis) return setupError(c, 'MFA enablement unavailable. Please try again later.', 503);
  const setupRaw = await redis.get(SETUP_KEY(userId));
  if (!setupRaw) return setupError(c, 'No pending MFA setup', 400);
  let setup: TotpSetupRecord;
  try {
    const parsed = JSON.parse(setupRaw) as Partial<TotpSetupRecord>;
    if (typeof parsed.secret !== 'string') throw new Error('Invalid setup data');
    // Bound to the epochs and the session that staged it. A record from
    // another session, or from before a factor change or admin reset, is left
    // in place for its owner (or its TTL) and answers "expired".
    if (
      !Number.isSafeInteger(parsed.authEpoch) || !Number.isSafeInteger(parsed.mfaEpoch)
      || parsed.authEpoch !== auth.token?.aep || parsed.mfaEpoch !== auth.token?.mep
      || typeof parsed.sid !== 'string' || !auth.token?.sid || parsed.sid !== auth.token.sid
      || (parsed.role !== 'initial' && parsed.role !== 'backup')
    ) {
      return setupError(c, SETUP_EXPIRED_MESSAGE, 400);
    }
    setup = parsed as TotpSetupRecord;
  } catch {
    return setupError(c, 'Invalid MFA setup data', 500);
  }

  // 2. Enrollment proof, validated (non-consuming).
  const enrollmentError = await resolveEnrollmentStepUp(
    c,
    auth,
    input.passwordAlreadyProven
      ? { ssoReauthGrantId: input.ssoReauthGrantId }
      : { currentPassword: input.currentPassword, ssoReauthGrantId: input.ssoReauthGrantId },
    {
      keyPrefix: 'mfa:pwd',
      consume: false,
      passwordAlreadyProven: input.passwordAlreadyProven,
      rejectionStatus: TOTP_PROOF_REJECTION_STATUS,
    },
  );
  if (enrollmentError) return enrollmentError;

  // 3. SR2-20: an already-protected account must present a fresh grant proving
  // the factor it holds (for a passkey primary, a passkey assertion).
  const stepUpError = await enforceExistingFactorStepUp(c, auth, input.stepUpGrantId, { consume: false });
  if (stepUpError) return stepUpError;

  // 4. Live policy.
  const policyError = await enforceTotpEnrollmentPolicy(c, auth);
  if (policyError) return policyError;

  // 5. Consuming verifier (SR2-24): the accepted time step cannot be replayed
  // at login. Fails closed when Redis is down.
  const valid = await consumeMFAToken(setup.secret, input.code, userId);
  // Failures from here on have burned the TOTP time step, so each is audited.
  const auditConfirmFailure = async (reason: string) => {
    const orgId = await resolveUserAuditOrgId(userId);
    writeAuthAudit(c, {
      orgId: orgId ?? undefined,
      action: setup.role === 'backup' ? 'auth.mfa.totp.register.failed' : 'auth.mfa.setup.failed',
      result: 'failure',
      reason,
      userId,
      email: auth.user.email,
      details: setup.role === 'backup'
        ? { phase: 'setup_confirmation', role: 'backup' }
        : { phase: 'setup_confirmation' },
    });
  };
  if (!valid) {
    await auditConfirmFailure('invalid_mfa_code');
    return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, TOTP_PROOF_REJECTION_STATUS);
  }

  // 6. The staged role must still match the live row. Advisory: the guarded
  // write in step 9 is the real check.
  const [live] = await runWithSystemDbAccess(() =>
    db
      .select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod, mfaSecret: users.mfaSecret })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );
  if (!live || totpSetupRoleFor(live) !== setup.role) {
    await auditConfirmFailure('factor_state_changed');
    return factorStateChanged(c, false);
  }
  const role = setup.role;

  const recoveryCodes = role === 'initial' ? generateRecoveryCodes() : null;
  const recoveryCodeHashes = recoveryCodes ? hashRecoveryCodes(recoveryCodes) : null;

  // 7. Reserve issuance before spending any grant.
  let capability: AuthIssuanceCapability;
  try {
    capability = await beginAuthIssuance(requestAuthBinding(c));
  } catch (error) {
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }

  // 8. Spend the grants. The add_factor consume re-checks the binding against
  // the LIVE epochs and fails CLOSED, so one grant authorizes one write.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, input.stepUpGrantId, { consume: true });
  if (stepUpConsumeError) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    return stepUpConsumeError;
  }
  // Conservative: when a grant was presented and the consume above passed, it
  // is gone (on an unprotected account the check is a no-op and the client
  // holds nothing worth keeping).
  const grantSpent = Boolean(input.stepUpGrantId);
  // #4018: the terminal burn for the passwordless SSO road (#7369: either
  // grant purpose). Omits `currentPassword` deliberately: the road-1
  // short-circuit would re-run argon2 and re-charge the step-up limiter after
  // the code above already burned its time step.
  const enrollmentConsumeError = await resolveEnrollmentStepUp(
    c,
    auth,
    { ssoReauthGrantId: input.ssoReauthGrantId },
    { keyPrefix: 'mfa:pwd', consume: true, passwordAlreadyProven: true, rejectionStatus: TOTP_PROOF_REJECTION_STATUS },
  );
  if (enrollmentConsumeError) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    return grantSpent ? withGrantConsumed(enrollmentConsumeError) : enrollmentConsumeError;
  }
  // Past this point the SSO enrollment grant is spent too, when one was sent
  // (conservative for a password account, whose grant is simply not needed).
  const anyGrantSpent = grantSpent || Boolean(input.ssoReauthGrantId);

  const encryptedSecret = encryptMfaSecret(setup.secret);

  // 9. The factor write.
  if (role === 'initial') {
    // SR2-07/SR2-19: enabling MFA folds the write into the epoch-bump +
    // refresh-family-revoke transaction and hands the caller a replacement
    // session; the codes are the account's first set.
    let result;
    try {
      result = await completeInitialMfaEnrollment({
        userId,
        identity: {
          userId,
          email: auth.user.email,
          roleId: auth.token?.roleId ?? null,
          orgId: auth.orgId ?? null,
          partnerId: auth.partnerId ?? null,
          scope: auth.scope,
          mfa: true,
          mfaSrc: 'factor',
          mobileDeviceId: readMobileDeviceId(c) ?? undefined,
        },
        capability,
        expectedAuthEpoch: auth.token?.aep as number,
        expectedMfaEpoch: auth.token?.mep as number,
        revokeReason: input.passwordAlreadyProven ? 'mfa-setup-confirm' : 'mfa-enable',
        recoveryCodes: recoveryCodes!,
        recoveryCodeHashes: recoveryCodeHashes!,
        persistFactor: async (tx, hashes) => {
          const rows = await tx
            .update(users)
            .set({
              mfaSecret: encryptedSecret,
              mfaEnabled: true,
              mfaMethod: 'totp',
              mfaRecoveryCodes: [...hashes],
              updatedAt: new Date(),
            })
            .where(eq(users.id, userId))
            .returning({ id: users.id });
          if (rows.length !== 1) throw new Error('MFA enrollment user disappeared');
          return undefined;
        },
      });
    } catch (error) {
      await cancelAuthIssuance(capability).catch(() => undefined);
      if (error instanceof AuthIssuanceConflictError) await auditConfirmFailure('factor_state_changed');
      const response = authIssuanceAdmissionError(c, error, { stepUpGrantConsumed: anyGrantSpent });
      if (!response) throw error;
      return response;
    }
    // 10.
    await bindIssuedUserSession(result.issued);
    installAuthorizedUserSessionCookies(c, result.issued);

    const setupOrgId = await resolveUserAuditOrgId(userId);
    writeAuthAudit(c, {
      orgId: setupOrgId ?? undefined,
      action: 'auth.mfa.setup',
      result: 'success',
      userId,
      email: auth.user.email,
      details: { method: 'totp', mfaEpoch: result.mfaEpoch, teardownFailed: result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED },
    });
    await releaseSetupRecord(userId, setupRaw);

    c.header('Cache-Control', 'no-store');
    return c.json({
      success: true,
      recoveryCodes: result.recoveryCodes,
      message: 'MFA enabled successfully',
      tokens: toPublicTokens(result.issued),
    });
  }

  // Backup (#10650): the account stays protected by its passkey primary. The
  // write still bumps mfa_epoch and revokes every OTHER session (SR2-07), keeps
  // the actor via a replacement session, and leaves the primary and the
  // recovery-code set exactly as they were (mirrors #5038 passkey add).
  let result;
  try {
    result = await completeAdditionalMfaFactorEnrollment({
      userId,
      identity: {
        userId,
        email: auth.user.email,
        roleId: auth.token?.roleId ?? null,
        orgId: auth.orgId ?? null,
        partnerId: auth.partnerId ?? null,
        scope: auth.scope,
        // Carry the caller's OWN assurance forward, never elevate it: the
        // step-up proves the existing factor, not the session.
        mfa: auth.token?.mfa === true,
        mfaSrc: auth.token?.mfa === true ? auth.token.mfa_src : undefined,
        // SR-001: a RE-MINT takes its device binding from the signed `mdid`
        // claim, never the forgeable request header.
        mobileDeviceId: carryForwardBinding(auth.token ?? {}),
      },
      capability,
      expectedAuthEpoch: auth.token?.aep as number,
      expectedMfaEpoch: auth.token?.mep as number,
      revokeReason: 'mfa-totp-backup-add',
      persistFactor: async (tx) => {
        // Guarded under the row lock the epoch bump took: still a passkey
        // primary with no secret. A zero-row update THROWS so the epoch bump
        // and the replacement session roll back with it.
        const rows = await tx
          .update(users)
          .set({ mfaSecret: encryptedSecret, updatedAt: new Date() })
          .where(and(
            eq(users.id, userId),
            eq(users.mfaEnabled, true),
            eq(users.mfaMethod, 'passkey'),
            isNull(users.mfaSecret),
          ))
          .returning({ id: users.id });
        if (rows.length !== 1) throw new AuthIssuanceConflictError();
        return undefined;
      },
    });
  } catch (error) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    if (error instanceof AuthIssuanceConflictError) {
      await auditConfirmFailure('factor_state_changed');
      return factorStateChanged(c, anyGrantSpent);
    }
    const response = authIssuanceAdmissionError(c, error, { stepUpGrantConsumed: anyGrantSpent });
    if (!response) throw error;
    return response;
  }

  // 10.
  const sessionInstalled = await installReplacementSession(c, result.issued, userId, 'totp_backup_add');
  const orgId = await resolveUserAuditOrgId(userId);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.totp.register',
    result: 'success',
    userId,
    email: auth.user.email,
    details: {
      role: 'backup',
      primaryMethod: 'passkey',
      mfaEpoch: result.mfaEpoch,
      teardownFailed: result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED,
      sessionInstalled,
    },
  });
  await releaseSetupRecord(userId, setupRaw);

  c.header('Cache-Control', 'no-store');
  // No `recoveryCodes` key at all: the primitive returns [] for this shape, and
  // an empty array must never reach a client that could read it as the new set.
  return c.json({
    success: true,
    backup: true,
    message: 'Authenticator app added as a backup. Your recovery codes have not changed.',
    ...(sessionInstalled ? { tokens: toPublicTokens(result.issued) } : {}),
  });
}

// ============================================
// POST /auth/mfa/totp/remove (#10650)
// ============================================

export const removeTotpSchema = z.object({
  currentPassword: z.string().min(1).max(256).optional(),
  ssoReauthGrantId: z.string().uuid().optional(),
  // Optional at validation so a stale client gets the stable
  // `existing_factor_step_up_required` boundary rather than a schema error.
  stepUpGrantId: z.string().min(1).max(256).optional(),
});

class LastRequiredMfaFactorError extends Error {}

function lastFactorRequired(c: Context, stepUpGrantConsumed: boolean): Response {
  return c.json({
    error: 'Keep at least one sign-in method your organization allows. Add a passkey before removing the authenticator app.',
    code: 'last_mfa_factor_required',
    ...(stepUpGrantConsumed ? { stepUpGrantConsumed: true } : {}),
  }, 403);
}

async function readTotpRemovalState(userId: string) {
  // System context, escaping the request context first: the factor count must
  // not depend on user-scoped RLS edge cases (same idiom as passkey removal).
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(async () =>
    db
      .select({
        mfaEnabled: users.mfaEnabled,
        mfaMethod: users.mfaMethod,
        mfaSecret: users.mfaSecret,
        passkeyCount: sql<number>`(
          SELECT COUNT(*)::int FROM user_passkeys
          WHERE user_id = ${userId} AND disabled_at IS NULL
        )`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  ));
  return row;
}

export const totpFactorRoutes = new Hono();

totpFactorRoutes.post('/mfa/totp/remove', authMiddleware, zValidator('json', removeTotpSchema), async (c) => {
  if (!ENABLE_2FA) return mfaDisabledResponse(c);

  const auth = c.get('auth');
  const userId = auth.user.id;
  const { currentPassword, ssoReauthGrantId, stepUpGrantId } = c.req.valid('json');
  const auditFailure = async (reason: string, details: Record<string, unknown> = {}) => {
    const orgId = await resolveUserAuditOrgId(userId);
    writeAuthAudit(c, {
      orgId: orgId ?? undefined,
      action: 'auth.mfa.totp.remove.failed',
      result: 'failure',
      reason,
      userId,
      email: auth.user.email,
      details,
    });
  };

  // 1. Mirrors passkey DELETE: removing a factor needs an MFA-assured session.
  if (auth.token?.mfa !== true) {
    await auditFailure('mfa_session_required');
    return c.json({ error: 'MFA verification is required to remove the authenticator app' }, 403);
  }

  // 2. "User at the keyboard": password, or a fresh IdP grant for a
  // passwordless account. Validated here, spent in step 8 just before the
  // factor write.
  const reauth = await resolveFactorManagementStepUp(
    c,
    auth,
    { currentPassword, ssoReauthGrantId },
    { keyPrefix: 'mfa:pwd', rejectionStatus: TOTP_PROOF_REJECTION_STATUS },
  );
  if ('error' in reauth) return reauth.error;

  // 3. Live row + policy.
  const state = await readTotpRemovalState(userId);
  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  }, { failClosed: true, failClosedMethods: true });

  // 4. Eligibility.
  if (!state || !hasActiveTotpFactor(state)) {
    await auditFailure('totp_not_enrolled');
    return c.json({ error: 'No authenticator app is set up on this account', code: 'totp_not_enrolled' }, 400);
  }

  // 5. A policy-allowed factor must survive, whether or not policy REQUIRES
  // MFA: login fails closed when an MFA-enabled account has no allowed method.
  const passkeyCount = Number(state.passkeyCount ?? 0);
  const survivingAllowed = policy.allowedMethods.passkey ? passkeyCount : 0;
  if (survivingAllowed === 0) {
    if (passkeyCount === 0) {
      await auditFailure('use_mfa_disable');
      return c.json({
        error: 'The authenticator app is your only sign-in method. Use Disable to turn off MFA instead.',
        code: 'use_mfa_disable',
      }, 400);
    }
    await auditFailure('last_mfa_factor_required');
    return lastFactorRequired(c, false);
  }

  // 6. Existing-factor proof, minted for remove_totp by a passkey or the
  // authenticator itself (never SMS or a recovery code — see /mfa/step-up).
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, {
    consume: false,
    operation: 'remove_totp',
  });
  if (stepUpError) {
    await auditFailure('step_up_required');
    return stepUpError;
  }

  // 7. Reserve issuance before spending anything.
  let capability: AuthIssuanceCapability;
  try {
    capability = await beginAuthIssuance(requestAuthBinding(c));
  } catch (error) {
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }

  // 8. Spend the grant, then the management grant.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, {
    consume: true,
    operation: 'remove_totp',
  });
  if (stepUpConsumeError) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    return stepUpConsumeError;
  }
  const reauthConsumeError = await consumeFactorManagementReauthGrant(c, auth, reauth.proof, {
    rejectionStatus: TOTP_PROOF_REJECTION_STATUS,
  });
  if (reauthConsumeError) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    return withGrantConsumed(reauthConsumeError);
  }

  // 9. The removal. Bumps mfa_epoch and revokes every other session; the
  // caller keeps a replacement carrying its own assurance.
  const previousPrimary = state.mfaMethod ?? 'totp';
  let result;
  try {
    result = await completeMfaFactorRemoval({
      userId,
      identity: {
        userId,
        email: auth.user.email,
        roleId: auth.token?.roleId ?? null,
        orgId: auth.orgId ?? null,
        partnerId: auth.partnerId ?? null,
        scope: auth.scope,
        mfa: auth.token?.mfa === true,
        mfaSrc: auth.token?.mfa === true ? auth.token.mfa_src : undefined,
        mobileDeviceId: carryForwardBinding(auth.token ?? {}),
      },
      capability,
      expectedAuthEpoch: auth.token?.aep as number,
      expectedMfaEpoch: auth.token?.mep as number,
      revokeReason: 'mfa-totp-remove',
      persistFactor: async (tx) => {
        // Re-count under the user-row lock the epoch bump took, so a
        // concurrent last-passkey delete cannot leave the account with no
        // policy-allowed factor.
        const [live] = await tx
          .select({
            passkeyCount: sql<number>`(
              SELECT COUNT(*)::int FROM user_passkeys
              WHERE user_id = ${userId} AND disabled_at IS NULL
            )`,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const allowedPasskeys = policy.allowedMethods.passkey ? Number(live?.passkeyCount ?? 0) : 0;
        if (allowedPasskeys === 0) throw new LastRequiredMfaFactorError();

        // The primary becomes (or stays) the passkey. mfa_enabled and the
        // recovery-code set are untouched: the account stays protected.
        const rows = await tx
          .update(users)
          .set({ mfaSecret: null, mfaMethod: 'passkey', updatedAt: new Date() })
          .where(and(eq(users.id, userId), activeTotpFactorSql()))
          .returning({ mfaMethod: users.mfaMethod });
        if (rows.length !== 1) throw new AuthIssuanceConflictError();
        return rows[0]!;
      },
    });
  } catch (error) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    if (error instanceof LastRequiredMfaFactorError) {
      await auditFailure('last_mfa_factor_required', { phase: 'write' });
      return lastFactorRequired(c, true);
    }
    if (error instanceof AuthIssuanceConflictError) {
      await auditFailure('factor_state_changed');
      return factorStateChanged(c, true);
    }
    const response = authIssuanceAdmissionError(c, error, { stepUpGrantConsumed: true });
    if (!response) throw error;
    return response;
  }

  // 10.
  const sessionInstalled = await installReplacementSession(c, result.issued, userId, 'totp_remove');
  const orgId = await resolveUserAuditOrgId(userId);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.totp.remove',
    result: 'success',
    userId,
    email: auth.user.email,
    details: {
      previousPrimary,
      newPrimary: result.value.mfaMethod,
      mfaEpoch: result.mfaEpoch,
      teardownFailed: result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED,
      sessionInstalled,
    },
  });

  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    mfaMethod: result.value.mfaMethod,
    ...(sessionInstalled ? { tokens: toPublicTokens(result.issued) } : {}),
  });
});
