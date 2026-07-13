import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  generateMFASecret,
  consumeMFAToken,
  generateOTPAuthURL,
  generateQRCode,
  generateRecoveryCodes,
  rateLimiter,
  mfaLimiter,
  getRedis,
  issueVerifiedPendingMfaSession,
  beginPendingMfaIssuance,
  cancelAuthIssuance,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  readPendingMfa,
  completeRecoveryCodeLogin,
  RecoveryCodeInvalidError,
  RecoveryCodeUnavailableError,
  rejectMalformedRecoveryCodeLogin,
} from '../../services';
import { getTwilioService } from '../../services/twilio';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { authMiddleware } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import {
  ENABLE_2FA,
  mfaVerifySchema,
  standardMfaVerifySchema,
  CSRF_COOKIE_NAME,
  mfaEnableSchema,
} from './schemas';
import {
  getClientIP,
  getCookieValue,
  rotateCsrfBindingCookie,
  setRefreshTokenCookie,
  toPublicTokens,
  encryptMfaSecret,
  decryptMfaSecret,
  decryptMfaSecretForMigration,
  hashRecoveryCodes,
  mfaDisabledResponse,
  resolveUserAuditOrgId,
  writeAuthAudit,
  auditUserLoginFailure,
  auditLogin,
  userRequiresSetup,
  requireCurrentPasswordStepUp,
  consumeMfaStepUpGrant,
  hashMfaStepUpGrant,
  MfaStepUpGrantInvalidError,
  MfaStepUpGrantUnavailableError,
  readMfaStepUpGrant,
} from './helpers';
import {
  cleanupMfaAssuranceUsers,
  MfaAssuranceMutationStaleError,
  runLockedMfaMutation,
} from '../../services/mfaAssuranceMutation';
import { resolveEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { withAuthLifecycleSystemTransaction } from '../../services/authLifecycle';
import { lockMfaAssuranceState } from '../../services/mfaAssuranceLocks';

const { db, withSystemDbAccessContext } = dbModule;

// Body schemas that require a password re-prompt. A stolen access token
// must not be sufficient to install/remove an MFA factor — these
// endpoints always re-verify the user's current password against the
// argon2 hash, rate-limited per user to blunt online password guessing.
const passwordOnlySchema = z.object({
  currentPassword: z.string().min(1).max(256)
});
const mfaSetupSchema = passwordOnlySchema.extend({
  mfaGrant: z.string().min(32).max(512).optional(),
});
const mfaEnableWithPasswordSchema = mfaEnableSchema.extend({
  currentPassword: z.string().min(1).max(256)
});
const mfaDisableSchema = standardMfaVerifySchema.extend({
  currentPassword: z.string().min(1).max(256)
});

export const mfaRoutes = new Hono();

function requestAuthBinding(c: Context) {
  return {
    kind: 'browser' as const,
    value: getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME) ?? '',
  };
}

function authTransitionErrorResponse(c: Context, error: unknown) {
  if (error instanceof AuthBindingRotationRequiredError) {
    rotateCsrfBindingCookie(c, error.replacement.value);
    return c.json({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }, 428);
  }
  if (error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  return null;
}

class MfaMutationRouteError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 501 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'MfaMutationRouteError';
  }
}

function lockedMutationInput(auth: ReturnType<typeof mfaAuthShape>, reason: string) {
  const authEpoch = auth.token.ae;
  const mfaEpoch = auth.token.me;
  if (!Number.isSafeInteger(authEpoch) || !Number.isSafeInteger(mfaEpoch)) {
    throw new MfaAssuranceMutationStaleError();
  }
  return {
    userId: auth.user.id,
    partnerId: auth.token.partnerId,
    authEpoch,
    mfaEpoch,
    reason,
  };
}

// Keeps the helper inferred from the middleware-owned auth object without
// duplicating the complete AuthContext type in this route module.
function mfaAuthShape(auth: AuthContext) { return auth; }

function mfaMutationErrorResponse(c: any, error: unknown) {
  if (error instanceof MfaAssuranceMutationStaleError) {
    return c.json({ error: 'Authentication state changed. Please sign in again.' }, 401);
  }
  if (error instanceof MfaMutationRouteError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof MfaStepUpGrantInvalidError) {
    return c.json({ error: 'Invalid or expired MFA step-up authorization' }, 401);
  }
  if (error instanceof MfaStepUpGrantUnavailableError) {
    return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  }
  throw error;
}

function totpReplaceBinding(auth: AuthContext) {
  const { sid, ae, me } = auth.token;
  if (!sid || !Number.isSafeInteger(ae) || !Number.isSafeInteger(me) || ae < 1 || me < 1) {
    throw new MfaStepUpGrantInvalidError();
  }
  return {
    purpose: 'totp.replace' as const,
    userId: auth.user.id,
    sessionId: sid,
    authEpoch: ae,
    mfaEpoch: me,
  };
}

function enrolledAllowedFactor(
  method: 'totp' | 'sms' | 'passkey',
  locked: Awaited<ReturnType<typeof lockMfaAssuranceState>>,
  allowedMethods: ReadonlySet<string>,
) {
  if (!allowedMethods.has(method)) return false;
  if (method === 'totp') return Boolean(locked.user?.mfaSecret);
  if (method === 'passkey') return locked.activePasskeyCount > 0;
  return locked.user?.mfaMethod === 'sms'
    && locked.user.phoneVerified === true
    && Boolean(locked.user.phoneNumber);
}

type TotpSetupState = { secret: string; recoveryCodes: string[]; grantHash?: string };

function parseTotpSetupState(raw: string): TotpSetupState {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.secret !== 'string'
    || !Array.isArray(parsed.recoveryCodes)
    || parsed.recoveryCodes.some((code) => typeof code !== 'string')
    || (parsed.grantHash !== undefined && typeof parsed.grantHash !== 'string')) {
    throw new Error('Invalid setup data');
  }
  return parsed as TotpSetupState;
}

async function auditMfaMutationFailure(c: any, auth: AuthContext, input: {
  action: 'auth.mfa.disable.failed' | 'auth.mfa.setup.failed';
  reason: string;
  details: Record<string, unknown>;
}) {
  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: input.action,
    result: 'failure',
    reason: input.reason,
    userId: auth.user.id,
    email: auth.user.email,
    details: input.details,
  });
}

async function auditRecoveryLoginFailure(
  c: any,
  userId: string | undefined,
  reason: 'mfa_invalid_recovery_code' | 'mfa_malformed_recovery_code',
) {
  if (userId) {
    await auditUserLoginFailure(c, {
      userId,
      reason,
      details: { method: 'recovery_code' },
    });
    return;
  }
  writeAuthAudit(c, {
    action: 'user.login.failed',
    result: 'failure',
    reason,
    details: { method: 'recovery_code' },
  });
}

async function confirmTotpSetup(c: any, input: {
  auth: AuthContext;
  code: string;
  mfaGrant?: string;
  redis: NonNullable<ReturnType<typeof getRedis>>;
  setup: TotpSetupState;
}) {
  const { auth, code, mfaGrant, redis, setup } = input;
  await runLockedMfaMutation(
    lockedMutationInput(auth, 'totp-factor-changed'),
    async (tx, locked) => {
      const policy = await resolveEffectiveMfaPolicy({
        userId: auth.user.id,
        roleId: auth.token.roleId,
        orgId: auth.token.orgId,
        partnerId: auth.token.partnerId,
        scope: auth.token.scope,
        tx,
      });
      if (!policy.allowedMethods.has('totp')) {
        throw new MfaMutationRouteError(403, 'TOTP is not allowed by the current MFA policy');
      }

      const hasExistingFactor = Boolean(locked.user?.mfaSecret)
        || (locked.user?.mfaMethod === 'sms' && locked.user.phoneVerified && Boolean(locked.user.phoneNumber))
        || locked.activePasskeyCount > 0;
      if (hasExistingFactor) {
        if (!mfaGrant || setup.grantHash !== hashMfaStepUpGrant(mfaGrant)) {
          throw new MfaMutationRouteError(403, 'Existing MFA factor proof is required to replace TOTP');
        }
        const binding = totpReplaceBinding(auth);
        const grant = await readMfaStepUpGrant(mfaGrant, binding);
        if (!enrolledAllowedFactor(grant.verifiedMethod, locked, policy.allowedMethods)) {
          throw new MfaMutationRouteError(403, 'Existing MFA factor proof is required to replace TOTP');
        }
        await consumeMfaStepUpGrant(mfaGrant, { ...binding, verifiedMethod: grant.verifiedMethod });
      } else if (setup.grantHash !== undefined || mfaGrant !== undefined) {
        throw new MfaStepUpGrantInvalidError();
      }

      if (!await consumeMFAToken(setup.secret, code, auth.user.id)) {
        await auditMfaMutationFailure(c, auth, {
          action: 'auth.mfa.setup.failed',
          reason: 'invalid_mfa_code',
          details: { phase: 'setup_confirmation' },
        });
        throw new MfaMutationRouteError(401, 'Invalid MFA code');
      }
      await tx.update(users).set({
        mfaSecret: encryptMfaSecret(setup.secret),
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaRecoveryCodes: hashRecoveryCodes(setup.recoveryCodes),
        updatedAt: new Date(),
      }).where(eq(users.id, auth.user.id));
    },
  );

  const setupKey = `mfa:setup:${auth.user.id}`;
  const cleanup = await cleanupMfaAssuranceUsers([auth.user.id], [
    { name: `mfa-setup-state:${auth.user.id}`, run: () => redis.del(setupKey) },
  ]);
  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp' },
  });
  return cleanup;
}

// MFA setup (requires auth + current-password re-prompt)
mfaRoutes.post('/mfa/setup', authMiddleware, zValidator('json', mfaSetupSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword, mfaGrant } = c.req.valid('json');

  // Re-verify password before allowing MFA factor installation. A stolen
  // access token is not sufficient — the user must prove possession of
  // the password to attach a new TOTP secret.
  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  let grantHash: string | undefined;
  try {
    grantHash = await withAuthLifecycleSystemTransaction(async (tx) => {
      const locked = await lockMfaAssuranceState(tx, {
        partnerId: auth.token.partnerId,
        userId: auth.user.id,
      });
      const binding = totpReplaceBinding(auth);
      if (!locked.user || locked.user.status !== 'active'
        || locked.user.authEpoch !== binding.authEpoch || locked.user.mfaEpoch !== binding.mfaEpoch) {
        throw new MfaStepUpGrantInvalidError();
      }
      const policy = await resolveEffectiveMfaPolicy({
        userId: auth.user.id, roleId: auth.token.roleId, orgId: auth.token.orgId,
        partnerId: auth.token.partnerId, scope: auth.token.scope, tx,
      });
      if (!policy.allowedMethods.has('totp')) {
        throw new MfaMutationRouteError(403, 'TOTP is not allowed by the current MFA policy');
      }
      const hasExistingFactor = Boolean(locked.user.mfaSecret)
        || (locked.user.mfaMethod === 'sms' && locked.user.phoneVerified && Boolean(locked.user.phoneNumber))
        || locked.activePasskeyCount > 0;
      if (!hasExistingFactor) {
        if (mfaGrant) throw new MfaStepUpGrantInvalidError();
        return undefined;
      }
      if (!mfaGrant) throw new MfaMutationRouteError(403, 'Existing MFA factor proof is required to replace TOTP');
      const grant = await readMfaStepUpGrant(mfaGrant, binding);
      if (!enrolledAllowedFactor(grant.verifiedMethod, locked, policy.allowedMethods)) {
        throw new MfaMutationRouteError(403, 'Existing MFA factor proof is required to replace TOTP');
      }
      return hashMfaStepUpGrant(mfaGrant);
    });
  } catch (error) {
    return mfaMutationErrorResponse(c, error);
  }

  // Generate new secret
  const secret = generateMFASecret();
  const otpAuthUrl = generateOTPAuthURL(secret, auth.user.email);
  const qrCodeDataUrl = await generateQRCode(otpAuthUrl);
  const recoveryCodes = generateRecoveryCodes();

  // Store secret temporarily (not enabled yet until verified)
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'MFA setup unavailable. Please try again later.' }, 503);
  }
  await redis.setex(
    `mfa:setup:${auth.user.id}`,
    600, // 10 min expiry
    JSON.stringify({ secret, recoveryCodes, ...(grantHash ? { grantHash } : {}) })
  );

  return c.json({
    secret,
    otpAuthUrl,
    qrCodeDataUrl,
    recoveryCodes
  });
});

// MFA verify (for login or setup confirmation)
mfaRoutes.post('/mfa/verify', zValidator('json', mfaVerifySchema, async (result, c) => {
  if (result.success) return;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return;
  }
  if (typeof raw === 'object' && raw !== null
    && (raw as { method?: unknown }).method === 'recovery_code') {
    const tempToken = typeof (raw as { tempToken?: unknown }).tempToken === 'string'
      ? (raw as { tempToken: string }).tempToken
      : undefined;
    let rejected;
    try {
      rejected = await rejectMalformedRecoveryCodeLogin(tempToken);
    } catch (error) {
      if (error instanceof RecoveryCodeUnavailableError) {
        return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
      }
      throw error;
    }
    await auditRecoveryLoginFailure(c, rejected.userId, 'mfa_malformed_recovery_code');
    return c.json({ error: 'Invalid MFA code' }, 401);
  }
}), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const verification = c.req.valid('json');
  const { code, tempToken, method } = verification;
  const mfaGrant = 'mfaGrant' in verification ? verification.mfaGrant : undefined;

  if (tempToken && method === 'recovery_code') {
    let completed;
    try {
      completed = await completeRecoveryCodeLogin({
        tempToken,
        code,
        authBinding: requestAuthBinding(c),
        mobileDeviceId: readMobileDeviceId(c) ?? undefined,
      });
    } catch (error) {
      if (error instanceof RecoveryCodeInvalidError) {
        await auditRecoveryLoginFailure(c, error.userId, 'mfa_invalid_recovery_code');
        return c.json({ error: 'Invalid MFA code' }, 401);
      }
      if (error instanceof RecoveryCodeUnavailableError) {
        return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
      }
      const transitionResponse = authTransitionErrorResponse(c, error);
      if (transitionResponse) return transitionResponse;
      throw error;
    }
    const { user: issuedUser, tokens, authority, remainingCount } = completed;
    auditLogin(c, {
      orgId: authority.orgId ?? null,
      userId: issuedUser.id,
      email: issuedUser.email,
      name: issuedUser.name,
      mfa: true,
      scope: authority.scope,
      ip: getClientIP(c),
      method: 'recovery_code',
      remainingRecoveryCodes: remainingCount,
    });
    setRefreshTokenCookie(c, tokens.refreshToken);
    return c.json({
      user: {
        id: issuedUser.id,
        email: issuedUser.email,
        name: issuedUser.name,
        mfaEnabled: true,
        avatarUrl: issuedUser.avatarUrl,
        isPlatformAdmin: issuedUser.isPlatformAdmin === true,
      },
      tokens: toPublicTokens(tokens),
      mfaRequired: false,
      requiresSetup: userRequiresSetup(issuedUser),
    });
  }
  const redis = getRedis();

  if (!redis) {
    return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  }

  // Case 1: Verifying during login (has tempToken)
  if (tempToken) {
    let pending;
    try {
      pending = await readPendingMfa(tempToken);
    } catch (error) {
      if (error instanceof PendingMfaUnavailableError) {
        return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
      }
      throw error;
    }
    if (!pending) {
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }

    // Rate limit MFA attempts
    const rateCheck = await rateLimiter(redis, `mfa:${pending.userId}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many MFA attempts' }, 429);
    }

    // Pre-auth lookup — wrap in system scope so the `users` RLS policy
    // doesn't deny the read before the real request scope is applied.
    const [user] = await withSystemDbAccessContext(async () =>
      db
        .select()
        .from(users)
        .where(eq(users.id, pending.userId))
        .limit(1)
    );

    if (!user) {
      return c.json({ error: 'Invalid MFA configuration' }, 400);
    }

    // Use the server-stored method only — never allow the client to override
    const effectiveMethod = pending.primaryMfaMethod;

    let capability;
    try {
      capability = await beginPendingMfaIssuance(pending, requestAuthBinding(c));
    } catch (error) {
      if (error instanceof PendingMfaInvalidError) {
        return c.json({ error: 'Invalid or expired MFA session' }, 401);
      }
      const transitionResponse = authTransitionErrorResponse(c, error);
      if (transitionResponse) return transitionResponse;
      throw error;
    }

    let valid = false;
    let migratedMfaSecret: string | null = null;
    if (effectiveMethod === 'passkey') {
      await cancelAuthIssuance(capability).catch(() => false);
      return c.json({ error: 'Use passkey verification for this MFA session' }, 400);
    }

    if (effectiveMethod === 'sms') {
      const phone = user.phoneNumber;
      if (!phone) {
        await cancelAuthIssuance(capability).catch(() => false);
        return c.json({ error: 'No phone number configured for SMS MFA' }, 400);
      }
      const twilio = getTwilioService();
      if (!twilio) {
        await cancelAuthIssuance(capability).catch(() => false);
        return c.json({ error: 'SMS service not configured' }, 501);
      }
      let result;
      try {
        result = await twilio.checkVerificationCode(phone, code);
      } catch (error) {
        await cancelAuthIssuance(capability).catch(() => false);
        throw error;
      }
      if (result.serviceError) {
        await cancelAuthIssuance(capability).catch(() => false);
        return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
      }
      valid = result.valid;
    } else {
      try {
        // TOTP verification
        const decrypted = decryptMfaSecretForMigration(user.mfaSecret);
        const decryptedMfaSecret = decrypted.plaintext;
        if (!decryptedMfaSecret) {
          await cancelAuthIssuance(capability).catch(() => false);
          return c.json({ error: 'Invalid MFA configuration' }, 400);
        }
        migratedMfaSecret = decrypted.migratedSecret;
        // consumeMFAToken: single-use per (user, step) so a live code can't be
        // replayed into a second login session. (security review #2)
        valid = await consumeMFAToken(decryptedMfaSecret, code, user.id);
      } catch (error) {
        await cancelAuthIssuance(capability).catch(() => false);
        throw error;
      }
    }

    if (!valid) {
      await cancelAuthIssuance(capability).catch(() => false);
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'mfa_invalid_code',
        details: { method: effectiveMethod }
      });
      return c.json({ error: 'Invalid MFA code' }, 401);
    }

    let completed;
    try {
      completed = await issueVerifiedPendingMfaSession({
        tempToken,
        expectedPending: pending,
        capability,
        verifiedMethod: effectiveMethod,
        mobileDeviceId: readMobileDeviceId(c) ?? undefined,
        finalizeFactor: migratedMfaSecret
          ? async (tx, issuedUser) => {
            await tx
              .update(users)
              .set({ mfaSecret: migratedMfaSecret, updatedAt: new Date() })
              .where(eq(users.id, issuedUser.id));
          }
          : undefined,
      });
    } catch (error) {
      await cancelAuthIssuance(capability).catch(() => false);
      if (error instanceof PendingMfaUnavailableError) {
        return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
      }
      if (error instanceof PendingMfaInvalidError) {
        return c.json({ error: 'Invalid or expired MFA session' }, 401);
      }
      const transitionResponse = authTransitionErrorResponse(c, error);
      if (transitionResponse) return transitionResponse;
      throw error;
    }
    const { user: issuedUser, tokens, authority } = completed;

    auditLogin(c, { orgId: authority.orgId ?? null, userId: issuedUser.id, email: issuedUser.email, name: issuedUser.name, mfa: true, scope: authority.scope, ip: getClientIP(c) });

    setRefreshTokenCookie(c, tokens.refreshToken);

    const requiresSetup = userRequiresSetup(issuedUser);

    return c.json({
      user: {
        id: issuedUser.id,
        email: issuedUser.email,
        name: issuedUser.name,
        mfaEnabled: true,
        avatarUrl: issuedUser.avatarUrl,
        // Mirrors the password-login payload — the auth store is seeded from
        // whichever of the two completes the login, and the sidebar gates
        // platform-admin-only nav on this flag.
        isPlatformAdmin: issuedUser.isPlatformAdmin === true
      },
      tokens: toPublicTokens(tokens),
      mfaRequired: false,
      requiresSetup
    });
  }

  // Case 2: confirming MFA setup for an already authenticated user.
  await authMiddleware(c, async () => {});
  const auth = c.get('auth');
  const setupData = await redis.get(`mfa:setup:${auth.user.id}`);
  if (!setupData) {
    return c.json({ error: 'No pending MFA setup' }, 400);
  }

  let setup: TotpSetupState;
  try {
    setup = parseTotpSetupState(setupData);
  } catch {
    return c.json({ error: 'Invalid MFA setup data' }, 500);
  }
  let cleanup;
  try {
    cleanup = await confirmTotpSetup(c, { auth, code, mfaGrant, redis, setup });
  } catch (error) {
    return mfaMutationErrorResponse(c, error);
  }

  return c.json({
    success: true,
    reauthenticate: true,
    message: 'MFA enabled successfully',
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
});

// MFA disable (requires auth + current MFA code + current password)
mfaRoutes.post('/mfa/disable', authMiddleware, zValidator('json', mfaDisableSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { code, currentPassword } = c.req.valid('json');

  // Re-verify password — defense in depth. The MFA code alone proves
  // possession of the second factor; the password proves the user is at
  // the keyboard right now (vs an attacker on a stolen access token who
  // somehow got an MFA code, e.g. social-engineered SMS).
  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  let currentMethod: string = 'totp';
  try {
    const [proofSnapshot] = await withSystemDbAccessContext(() => db
      .select({
        status: users.status,
        authEpoch: users.authEpoch,
        mfaEpoch: users.mfaEpoch,
        mfaEnabled: users.mfaEnabled,
        mfaMethod: users.mfaMethod,
        phoneNumber: users.phoneNumber,
        phoneVerified: users.phoneVerified,
      })
      .from(users)
      .where(eq(users.id, auth.user.id))
      .limit(1));
    if (!proofSnapshot
      || proofSnapshot.status !== 'active'
      || proofSnapshot.authEpoch !== auth.token.ae
      || proofSnapshot.mfaEpoch !== auth.token.me) {
      throw new MfaAssuranceMutationStaleError();
    }

    let verifiedSmsPhone: string | null = null;
    if (proofSnapshot.mfaEnabled && proofSnapshot.mfaMethod === 'sms') {
      const twilio = getTwilioService();
      if (!twilio) throw new MfaMutationRouteError(501, 'SMS service not configured');
      if (!proofSnapshot.phoneVerified || !proofSnapshot.phoneNumber) {
        throw new MfaMutationRouteError(400, 'No verified phone number configured');
      }
      const result = await twilio.checkVerificationCode(proofSnapshot.phoneNumber, code);
      if (result.serviceError) {
        throw new MfaMutationRouteError(502, 'SMS verification service temporarily unavailable. Please try again.');
      }
      if (!result.valid) {
        await auditMfaMutationFailure(c, auth, {
          action: 'auth.mfa.disable.failed',
          reason: 'invalid_sms_code',
          details: { method: 'sms' },
        });
        throw new MfaMutationRouteError(401, 'Invalid verification code');
      }
      // This request-local proof cannot be replayed by a client. The locked
      // transaction below accepts it only if the exact phone/factor snapshot
      // and token epochs are still live.
      verifiedSmsPhone = proofSnapshot.phoneNumber;
    }

    await runLockedMfaMutation(
      lockedMutationInput(auth, 'mfa-disabled'),
      async (tx, locked) => {
        const user = locked.user!;
        const policy = await resolveEffectiveMfaPolicy({
          userId: auth.user.id,
          roleId: auth.token.roleId,
          orgId: auth.token.orgId,
          partnerId: auth.token.partnerId,
          scope: auth.token.scope,
          tx,
        });
        if (policy.required) {
          throw new MfaMutationRouteError(403, 'Your organization or role requires MFA. Contact your admin to change this policy.');
        }
        if (!user.mfaEnabled) throw new MfaMutationRouteError(400, 'MFA is not enabled');
        currentMethod = user.mfaMethod || 'totp';
        if (currentMethod === 'sms') {
          if (!verifiedSmsPhone
            || !user.phoneVerified
            || user.phoneNumber !== verifiedSmsPhone) {
            throw new MfaAssuranceMutationStaleError();
          }
        } else {
          if (verifiedSmsPhone !== null) throw new MfaAssuranceMutationStaleError();
          const decryptedMfaSecret = decryptMfaSecret(user.mfaSecret);
          if (!decryptedMfaSecret) throw new MfaMutationRouteError(400, 'Invalid MFA configuration');
          if (!await consumeMFAToken(decryptedMfaSecret, code, auth.user.id)) {
            await auditMfaMutationFailure(c, auth, {
              action: 'auth.mfa.disable.failed',
              reason: 'invalid_mfa_code',
              details: { method: 'totp' },
            });
            throw new MfaMutationRouteError(401, 'Invalid MFA code');
          }
        }
        await tx
          .update(users)
          .set({
            mfaSecret: null,
            mfaEnabled: false,
            mfaMethod: null,
            mfaRecoveryCodes: null,
            phoneNumber: null,
            phoneVerified: false,
            updatedAt: new Date()
          })
          .where(eq(users.id, auth.user.id));
      },
    );
  } catch (error) {
    return mfaMutationErrorResponse(c, error);
  }
  const cleanup = await cleanupMfaAssuranceUsers([auth.user.id]);

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.disable',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: currentMethod }
  });

  return c.json({
    success: true,
    reauthenticate: true,
    message: 'MFA disabled successfully',
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
});

// MFA enable compatibility endpoint for frontend settings flow
mfaRoutes.post('/mfa/enable', authMiddleware, zValidator('json', mfaEnableWithPasswordSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { code, currentPassword, mfaGrant } = c.req.valid('json');

  // Re-verify password before flipping mfaEnabled=true on the user row.
  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  const redis = getRedis();

  if (!redis) {
    const message = 'MFA enablement unavailable. Please try again later.';
    return c.json({ error: message, message }, 503);
  }

  const setupData = await redis.get(`mfa:setup:${auth.user.id}`);
  if (!setupData) {
    const message = 'No pending MFA setup';
    return c.json({ error: message, message }, 400);
  }

  let setup: TotpSetupState;
  try {
    setup = parseTotpSetupState(setupData);
  } catch {
    const message = 'Invalid MFA setup data';
    return c.json({ error: message, message }, 500);
  }

  let cleanup;
  try {
    cleanup = await confirmTotpSetup(c, { auth, code, mfaGrant, redis, setup });
  } catch (error) {
    return mfaMutationErrorResponse(c, error);
  }

  return c.json({
    success: true,
    reauthenticate: true,
    recoveryCodes: setup.recoveryCodes,
    message: 'MFA enabled successfully',
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
});

// Generate new MFA recovery codes for the authenticated user
mfaRoutes.post('/mfa/recovery-codes', authMiddleware, zValidator('json', passwordOnlySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  const recoveryCodes = generateRecoveryCodes();
  try {
    await runLockedMfaMutation(
      lockedMutationInput(auth, 'mfa-recovery-codes-rotated'),
      async (tx, locked) => {
        if (!locked.user?.mfaEnabled) {
          throw new MfaMutationRouteError(400, 'MFA must be enabled before generating recovery codes');
        }
        await tx
          .update(users)
          .set({
            mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
            updatedAt: new Date()
          })
          .where(eq(users.id, auth.user.id));
      },
    );
  } catch (error) {
    return mfaMutationErrorResponse(c, error);
  }
  const cleanup = await cleanupMfaAssuranceUsers([auth.user.id]);

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.recovery_codes.rotate',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { count: recoveryCodes.length }
  });

  return c.json({
    success: true,
    reauthenticate: true,
    recoveryCodes,
    message: 'Recovery codes generated successfully',
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
});
