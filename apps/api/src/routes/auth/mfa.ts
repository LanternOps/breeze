import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { users, organizations } from '../../db/schema';
import {
  createTokenPair,
  generateMFASecret,
  verifyMFAToken,
  generateOTPAuthURL,
  generateQRCode,
  generateRecoveryCodes,
  rateLimiter,
  mfaLimiter,
  getRedis
} from '../../services';
import { getTwilioService } from '../../services/twilio';
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
  resolveCurrentUserTokenContext,
  resolveUserAuditOrgId,
  writeAuthAudit,
  auditUserLoginFailure,
  auditLogin,
  userRequiresSetup,
  requireCurrentPasswordStepUp
} from './helpers';

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
    const pendingRaw = await redis.get(`mfa:pending:${tempToken}`);
    if (!pendingRaw) {
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }

    // Parse pending data — supports both legacy (plain userId string) and new (JSON) format
    let pendingUserId: string;
    let pendingMfaMethod: string;
    try {
      const parsed = JSON.parse(pendingRaw);
      pendingUserId = parsed.userId;
      pendingMfaMethod = parsed.mfaMethod || 'totp';
    } catch {
      // Legacy format: plain userId string
      pendingUserId = pendingRaw;
      pendingMfaMethod = 'totp';
    }

    // Rate limit MFA attempts
    const rateCheck = await rateLimiter(redis, `mfa:${pendingUserId}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many MFA attempts' }, 429);
    }

    // Pre-auth lookup — wrap in system scope so the `users` RLS policy
    // doesn't deny the read before the real request scope is applied.
    const [user] = await withSystemDbAccessContext(async () =>
      db
        .select()
        .from(users)
        .where(eq(users.id, pendingUserId))
        .limit(1)
    );

    if (!user) {
      return c.json({ error: 'Invalid MFA configuration' }, 400);
    }

    // Use the server-stored method only — never allow the client to override
    const effectiveMethod = pendingMfaMethod;

    let valid = false;
    let migratedMfaSecret: string | null = null;
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
      valid = await verifyMFAToken(decryptedMfaSecret, code);
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

    // Clear temp token
    await redis.del(`mfa:pending:${tempToken}`);

    // Look up user's partner/org context
    const mfaContext = await resolveCurrentUserTokenContext(user.id);
    const mfaRoleId = mfaContext.roleId;
    const mfaPartnerId = mfaContext.partnerId;
    const mfaOrgId = mfaContext.orgId;
    const mfaScope = mfaContext.scope;

    // Create tokens with user's context
    const tokens = await createTokenPair({
      sub: user.id,
      email: user.email,
      roleId: mfaRoleId,
      orgId: mfaOrgId,
      partnerId: mfaPartnerId,
      scope: mfaScope,
      mfa: true
    });

    // Update last login
    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        ...(migratedMfaSecret ? { mfaSecret: migratedMfaSecret, updatedAt: new Date() } : {})
      })
      .where(eq(users.id, user.id));

    auditLogin(c, { orgId: mfaOrgId ?? null, userId: user.id, email: user.email, name: user.name, mfa: true, scope: mfaScope, ip: getClientIP(c) });

    setRefreshTokenCookie(c, tokens.refreshToken);

    const requiresSetup = userRequiresSetup(user);

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: true
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
  const valid = await verifyMFAToken(secret, code);

  if (!valid) {
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
    return c.json({ error: 'Invalid MFA code' }, 401);
  }

  await db
    .update(users)
    .set({
      mfaSecret: encryptMfaSecret(secret),
      mfaEnabled: true,
      mfaMethod: 'totp',
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

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

  return c.json({ success: true, message: 'MFA enabled successfully' });
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

  // Check org policy — if requireMfa is true, block disable
  if (auth.orgId) {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, auth.orgId))
      .limit(1);

    const orgSettings = org?.settings as { security?: { requireMfa?: boolean } } | null;
    if (orgSettings?.security?.requireMfa) {
      return c.json({ error: 'Your organization requires MFA. Contact your admin to change this policy.' }, 403);
    }
  }

  const [user] = await db
    .select({
      mfaSecret: users.mfaSecret,
      mfaEnabled: users.mfaEnabled,
      mfaMethod: users.mfaMethod,
      phoneNumber: users.phoneNumber
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user?.mfaEnabled) {
    return c.json({ error: 'MFA is not enabled' }, 400);
  }

  const currentMethod = user.mfaMethod || 'totp';

  // Verify using the appropriate method
  if (currentMethod === 'sms') {
    // For SMS MFA disable, we require a fresh SMS code
    const twilio = getTwilioService();
    if (!twilio) {
      return c.json({ error: 'SMS service not configured' }, 501);
    }

    if (!user.phoneNumber) {
      return c.json({ error: 'No phone number configured' }, 400);
    }
    const result = await twilio.checkVerificationCode(user.phoneNumber, code);
    if (result.serviceError) {
      return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
    }
    if (!result.valid) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.mfa.disable.failed',
        result: 'failure',
        reason: 'invalid_sms_code',
        userId: auth.user.id,
        email: auth.user.email,
        details: { method: 'sms' }
      });
      return c.json({ error: 'Invalid verification code' }, 401);
    }
  } else {
    // TOTP
    const decryptedMfaSecret = decryptMfaSecret(user.mfaSecret);
    if (!decryptedMfaSecret) {
      return c.json({ error: 'Invalid MFA configuration' }, 400);
    }
    const valid = await verifyMFAToken(decryptedMfaSecret, code);
    if (!valid) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.mfa.disable.failed',
        result: 'failure',
        reason: 'invalid_mfa_code',
        userId: auth.user.id,
        email: auth.user.email,
        details: { method: 'totp' }
      });
      return c.json({ error: 'Invalid MFA code' }, 401);
    }
  }

  await db
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

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.disable',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: currentMethod }
  });

  return c.json({ success: true, message: 'MFA disabled successfully' });
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

  const valid = await verifyMFAToken(secret, code);
  if (!valid) {
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
    const message = 'Invalid MFA code';
    return c.json({ error: message, message }, 401);
  }

  await db
    .update(users)
    .set({
      mfaSecret: encryptMfaSecret(secret),
      mfaEnabled: true,
      mfaMethod: 'totp',
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  await redis.del(`mfa:setup:${auth.user.id}`);

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: setupOrgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp' }
  });

  return c.json({ success: true, recoveryCodes, message: 'MFA enabled successfully' });
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

  const [user] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user?.mfaEnabled) {
    const message = 'MFA must be enabled before generating recovery codes';
    return c.json({ error: message, message }, 400);
  }

  const recoveryCodes = generateRecoveryCodes();
  await db
    .update(users)
    .set({
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.recovery_codes.rotate',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { count: recoveryCodes.length }
  });

  return c.json({ success: true, recoveryCodes, message: 'Recovery codes generated successfully' });
});
