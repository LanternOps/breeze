import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, organizations } from '../../db/schema';
import {
  createTokenPair,
  verifyToken,
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
  hashRecoveryCodes,
  mfaDisabledResponse,
  isTokenRevokedForUser,
  resolveCurrentUserTokenContext,
  resolveUserAuditOrgId,
  writeAuthAudit,
  auditUserLoginFailure,
  auditLogin
} from './helpers';

const { db } = dbModule;

export const mfaRoutes = new Hono();

// MFA setup (requires auth)
mfaRoutes.post('/mfa/setup', authMiddleware, async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');

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

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, pendingUserId))
      .limit(1);

    if (!user) {
      return c.json({ error: 'Invalid MFA configuration' }, 400);
    }

    // Use the server-stored method only — never allow the client to override
    const effectiveMethod = pendingMfaMethod;

    let valid = false;
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
      const decryptedMfaSecret = decryptMfaSecret(user.mfaSecret);
      if (!decryptedMfaSecret) {
        return c.json({ error: 'Invalid MFA configuration' }, 400);
      }
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
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    if (mfaOrgId) {
      auditLogin(c, { orgId: mfaOrgId, userId: user.id, email: user.email, name: user.name, mfa: true, scope: mfaScope, ip: getClientIP(c) });
    } else {
      console.warn('[audit] Skipping MFA login audit for non-org-scoped user', { userId: user.id, scope: mfaScope });
    }

    setRefreshTokenCookie(c, tokens.refreshToken);

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: true
      },
      tokens: toPublicTokens(tokens),
      mfaRequired: false
    });
  }

  // Case 2: Confirming MFA setup (requires auth)
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);
  if (!payload) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  if (await isTokenRevokedForUser(payload.sub, payload.iat)) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  const setupData = await redis.get(`mfa:setup:${payload.sub}`);
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
    const orgId = await resolveUserAuditOrgId(payload.sub);
    if (orgId) {
      writeAuthAudit(c, {
        orgId,
        action: 'auth.mfa.setup.failed',
        result: 'failure',
        reason: 'invalid_mfa_code',
        userId: payload.sub,
        details: { phase: 'setup_confirmation' }
      });
    }
    return c.json({ error: 'Invalid MFA code' }, 401);
  }

  // Enable MFA (TOTP)
  await db
    .update(users)
    .set({
      mfaSecret: encryptMfaSecret(secret),
      mfaEnabled: true,
      mfaMethod: 'totp',
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, payload.sub));

  const setupOrgId = await resolveUserAuditOrgId(payload.sub);
  if (setupOrgId) {
    writeAuthAudit(c, {
      orgId: setupOrgId,
      action: 'auth.mfa.setup',
      result: 'success',
      userId: payload.sub,
      details: { method: 'totp' }
    });
  }

  // Clear setup data
  await redis.del(`mfa:setup:${payload.sub}`);

  return c.json({ success: true, message: 'MFA enabled successfully' });
});

// MFA disable (requires auth + current MFA code)
mfaRoutes.post('/mfa/disable', authMiddleware, zValidator('json', mfaVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { code } = c.req.valid('json');

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
      if (auth.orgId) {
        writeAuthAudit(c, {
          orgId: auth.orgId,
          action: 'auth.mfa.disable.failed',
          result: 'failure',
          reason: 'invalid_sms_code',
          userId: auth.user.id,
          email: auth.user.email,
          details: { method: 'sms' }
        });
      }
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
      if (auth.orgId) {
        writeAuthAudit(c, {
          orgId: auth.orgId,
          action: 'auth.mfa.disable.failed',
          result: 'failure',
          reason: 'invalid_mfa_code',
          userId: auth.user.id,
          email: auth.user.email,
          details: { method: 'totp' }
        });
      }
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

  if (auth.orgId) {
    writeAuthAudit(c, {
      orgId: auth.orgId,
      action: 'auth.mfa.disable',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: currentMethod }
    });
  }

  return c.json({ success: true, message: 'MFA disabled successfully' });
});

// MFA enable compatibility endpoint for frontend settings flow
mfaRoutes.post('/mfa/enable', authMiddleware, zValidator('json', mfaEnableSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { code } = c.req.valid('json');
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
    if (orgId) {
      writeAuthAudit(c, {
        orgId,
        action: 'auth.mfa.setup.failed',
        result: 'failure',
        reason: 'invalid_mfa_code',
        userId: auth.user.id,
        email: auth.user.email,
        details: { phase: 'setup_confirmation' }
      });
    }
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
  if (setupOrgId) {
    writeAuthAudit(c, {
      orgId: setupOrgId,
      action: 'auth.mfa.setup',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: 'totp' }
    });
  }

  return c.json({ success: true, recoveryCodes, message: 'MFA enabled successfully' });
});

// Generate new MFA recovery codes for the authenticated user
mfaRoutes.post('/mfa/recovery-codes', authMiddleware, async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');

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
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.mfa.recovery_codes.rotate',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { count: recoveryCodes.length }
    });
  }

  return c.json({ success: true, recoveryCodes, message: 'Recovery codes generated successfully' });
});
