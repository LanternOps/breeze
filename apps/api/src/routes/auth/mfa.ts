import { Hono } from 'hono';
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
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  readPendingMfa,
} from '../../services';
import { getTwilioService } from '../../services/twilio';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { authMiddleware } from '../../middleware/auth';
import { ENABLE_2FA, mfaVerifySchema, mfaEnableSchema } from './schemas';
import {
  getClientIP,
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
  requireCurrentPasswordStepUp
} from './helpers';
import {
  cleanupMfaAssuranceUsers,
  MfaAssuranceMutationStaleError,
  runLockedMfaMutation,
} from '../../services/mfaAssuranceMutation';
import { resolveEffectiveMfaPolicy } from '../../services/mfaPolicy';

const { db, withSystemDbAccessContext } = dbModule;

// Body schemas that require a password re-prompt. A stolen access token
// must not be sufficient to install/remove an MFA factor — these
// endpoints always re-verify the user's current password against the
// argon2 hash, rate-limited per user to blunt online password guessing.
const passwordOnlySchema = z.object({
  currentPassword: z.string().min(1).max(256)
});
const mfaEnableWithPasswordSchema = mfaEnableSchema.extend({
  currentPassword: z.string().min(1).max(256)
});
const mfaDisableSchema = mfaVerifySchema.extend({
  currentPassword: z.string().min(1).max(256)
});

export const mfaRoutes = new Hono();

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
function mfaAuthShape(auth: any) { return auth; }

function mfaMutationErrorResponse(c: any, error: unknown) {
  if (error instanceof MfaAssuranceMutationStaleError) {
    return c.json({ error: 'Authentication state changed. Please sign in again.' }, 401);
  }
  if (error instanceof MfaMutationRouteError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

// MFA setup (requires auth + current-password re-prompt)
mfaRoutes.post('/mfa/setup', authMiddleware, zValidator('json', passwordOnlySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword } = c.req.valid('json');

  // Re-verify password before allowing MFA factor installation. A stolen
  // access token is not sufficient — the user must prove possession of
  // the password to attach a new TOTP secret.
  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  // Check if MFA is already enabled
  const [user] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (user?.mfaEnabled) {
    return c.json({ error: 'MFA is already enabled' }, 400);
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
    JSON.stringify({ secret, recoveryCodes })
  );

  return c.json({
    secret,
    otpAuthUrl,
    qrCodeDataUrl,
    recoveryCodes
  });
});

// MFA verify (for login or setup confirmation)
mfaRoutes.post('/mfa/verify', zValidator('json', mfaVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const { code, tempToken } = c.req.valid('json');
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

    let valid = false;
    let migratedMfaSecret: string | null = null;
    if (effectiveMethod === 'passkey') {
      return c.json({ error: 'Use passkey verification for this MFA session' }, 400);
    }

    if (effectiveMethod === 'sms') {
      const phone = user.phoneNumber;
      if (!phone) {
        return c.json({ error: 'No phone number configured for SMS MFA' }, 400);
      }
      const twilio = getTwilioService();
      if (!twilio) {
        return c.json({ error: 'SMS service not configured' }, 501);
      }
      const result = await twilio.checkVerificationCode(phone, code);
      if (result.serviceError) {
        return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
      }
      valid = result.valid;
    } else {
      // TOTP verification
      const decrypted = decryptMfaSecretForMigration(user.mfaSecret);
      const decryptedMfaSecret = decrypted.plaintext;
      if (!decryptedMfaSecret) {
        return c.json({ error: 'Invalid MFA configuration' }, 400);
      }
      migratedMfaSecret = decrypted.migratedSecret;
      // consumeMFAToken: single-use per (user, step) so a live code can't be
      // replayed into a second login session. (security review #2)
      valid = await consumeMFAToken(decryptedMfaSecret, code, user.id);
    }

    if (!valid) {
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
        verifiedMethod: effectiveMethod,
        mobileDeviceId: readMobileDeviceId(c) ?? undefined,
      });
    } catch (error) {
      if (error instanceof PendingMfaUnavailableError) {
        return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
      }
      if (error instanceof PendingMfaInvalidError) {
        return c.json({ error: 'Invalid or expired MFA session' }, 401);
      }
      throw error;
    }
    const { user: issuedUser, tokens, authority } = completed;

    // Update last login
    // System DB context required: the MFA-verify step is still unauthenticated,
    // so without it this `users` RLS UPDATE silently matches 0 rows under
    // breeze_app — freezing last_login_at AND silently dropping the mfaSecret
    // migration write (#1375).
    await withSystemDbAccessContext(() =>
      db
        .update(users)
        .set({
          lastLoginAt: new Date(),
          ...(migratedMfaSecret ? { mfaSecret: migratedMfaSecret, updatedAt: new Date() } : {})
        })
        .where(eq(users.id, issuedUser.id))
    );

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

  let secret: string;
  let recoveryCodes: string[];
  try {
    const parsed = JSON.parse(setupData);
    secret = parsed.secret;
    recoveryCodes = parsed.recoveryCodes;
  } catch {
    return c.json({ error: 'Invalid MFA setup data' }, 500);
  }
  try {
    await runLockedMfaMutation(
      lockedMutationInput(auth, 'totp-factor-changed'),
      async (tx, locked) => {
        if (locked.user?.mfaEnabled) {
          throw new MfaMutationRouteError(403, 'Existing MFA factor proof is required to replace TOTP');
        }
        if (!await consumeMFAToken(secret, code, auth.user.id)) {
          const orgId = await resolveUserAuditOrgId(auth.user.id);
          writeAuthAudit(c, {
            orgId: orgId ?? undefined,
            action: 'auth.mfa.setup.failed',
            result: 'failure',
            reason: 'invalid_mfa_code',
            userId: auth.user.id,
            email: auth.user.email,
            details: { phase: 'setup_confirmation' }
          });
          throw new MfaMutationRouteError(401, 'Invalid MFA code');
        }
        await tx
          .update(users)
          .set({
            mfaSecret: encryptMfaSecret(secret),
            mfaEnabled: true,
            mfaMethod: 'totp',
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

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: setupOrgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp' }
  });

  await redis.del(`mfa:setup:${auth.user.id}`);

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
          const twilio = getTwilioService();
          if (!twilio) throw new MfaMutationRouteError(501, 'SMS service not configured');
          if (!user.phoneNumber) throw new MfaMutationRouteError(400, 'No phone number configured');
          const result = await twilio.checkVerificationCode(user.phoneNumber, code);
          if (result.serviceError) throw new MfaMutationRouteError(502, 'SMS verification service temporarily unavailable. Please try again.');
          if (!result.valid) throw new MfaMutationRouteError(401, 'Invalid verification code');
        } else {
          const decryptedMfaSecret = decryptMfaSecret(user.mfaSecret);
          if (!decryptedMfaSecret) throw new MfaMutationRouteError(400, 'Invalid MFA configuration');
          if (!await consumeMFAToken(decryptedMfaSecret, code, auth.user.id)) {
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
  const { code, currentPassword } = c.req.valid('json');

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

  let secret: string;
  let recoveryCodes: string[];
  try {
    const parsed = JSON.parse(setupData) as { secret?: unknown; recoveryCodes?: unknown };
    if (typeof parsed.secret !== 'string' || !Array.isArray(parsed.recoveryCodes) || parsed.recoveryCodes.some(code => typeof code !== 'string')) {
      throw new Error('Invalid setup data');
    }
    secret = parsed.secret;
    recoveryCodes = parsed.recoveryCodes;
  } catch {
    const message = 'Invalid MFA setup data';
    return c.json({ error: message, message }, 500);
  }

  try {
    await runLockedMfaMutation(
      lockedMutationInput(auth, 'totp-factor-changed'),
      async (tx, locked) => {
        if (locked.user?.mfaEnabled) {
          throw new MfaMutationRouteError(403, 'Existing MFA factor proof is required to replace TOTP');
        }
        if (!await consumeMFAToken(secret, code, auth.user.id)) {
          throw new MfaMutationRouteError(401, 'Invalid MFA code');
        }
        await tx
          .update(users)
          .set({
            mfaSecret: encryptMfaSecret(secret),
            mfaEnabled: true,
            mfaMethod: 'totp',
            mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
            updatedAt: new Date()
          })
          .where(eq(users.id, auth.user.id));
      },
    );
  } catch (error) {
    return mfaMutationErrorResponse(c, error);
  }

  await redis.del(`mfa:setup:${auth.user.id}`);
  const cleanup = await cleanupMfaAssuranceUsers([auth.user.id]);

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: setupOrgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp' }
  });

  return c.json({
    success: true,
    reauthenticate: true,
    recoveryCodes,
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
