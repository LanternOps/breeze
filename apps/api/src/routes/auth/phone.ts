import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, organizations } from '../../db/schema';
import {
  generateRecoveryCodes,
  rateLimiter,
  getRedis,
  smsPhoneVerifyLimiter,
  smsPhoneVerifyUserLimiter,
  smsLoginSendLimiter,
  smsLoginGlobalLimiter,
  phoneConfirmLimiter
} from '../../services';
import { getTwilioService } from '../../services/twilio';
import { authMiddleware } from '../../middleware/auth';
import { ENABLE_2FA, phoneVerifySchema, phoneConfirmSchema, smsSendSchema } from './schemas';
import {
  mfaDisabledResponse,
  hashRecoveryCodes,
  resolveUserAuditOrgId,
  writeAuthAudit
} from './helpers';

const { db } = dbModule;

export const phoneRoutes = new Hono();

// Phone verification - send code (authenticated)
phoneRoutes.post('/phone/verify', authMiddleware, zValidator('json', phoneVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { phoneNumber } = c.req.valid('json');

  const twilio = getTwilioService();
  if (!twilio) {
    return c.json({ error: 'SMS service not configured' }, 501);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Rate limit per phone number
  const phoneRate = await rateLimiter(
    redis,
    `sms:phone-verify:${phoneNumber}`,
    smsPhoneVerifyLimiter.limit,
    smsPhoneVerifyLimiter.windowSeconds
  );
  if (!phoneRate.allowed) {
    return c.json({ error: 'Too many verification attempts for this number. Try again later.' }, 429);
  }

  // Rate limit per user
  const userRate = await rateLimiter(
    redis,
    `sms:phone-verify-user:${auth.user.id}`,
    smsPhoneVerifyUserLimiter.limit,
    smsPhoneVerifyUserLimiter.windowSeconds
  );
  if (!userRate.allowed) {
    return c.json({ error: 'Too many verification attempts. Try again later.' }, 429);
  }

  const result = await twilio.sendVerificationCode(phoneNumber);
  if (!result.success) {
    if (result.isUserError) {
      return c.json({ error: 'Invalid phone number. Please use a mobile phone number in E.164 format.' }, 400);
    }
    return c.json({ error: 'Failed to send verification code' }, 500);
  }

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.phone.verify.requested',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { phoneLast4: phoneNumber.slice(-4) }
    });
  }

  return c.json({ success: true, message: 'Verification code sent' });
});

// Phone verification - confirm code (authenticated)
phoneRoutes.post('/phone/confirm', authMiddleware, zValidator('json', phoneConfirmSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { phoneNumber, code } = c.req.valid('json');

  const twilio = getTwilioService();
  if (!twilio) {
    return c.json({ error: 'SMS service not configured' }, 501);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Rate limit confirmation attempts
  const rateCheck = await rateLimiter(
    redis,
    `sms:phone-confirm:${auth.user.id}`,
    phoneConfirmLimiter.limit,
    phoneConfirmLimiter.windowSeconds
  );
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  }

  const result = await twilio.checkVerificationCode(phoneNumber, code);
  if (result.serviceError) {
    return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
  }

  const orgId = await resolveUserAuditOrgId(auth.user.id);

  if (!result.valid) {
    if (orgId) {
      writeAuthAudit(c, {
        orgId,
        action: 'auth.phone.verify.failed',
        result: 'failure',
        reason: 'invalid_code',
        userId: auth.user.id,
        email: auth.user.email,
        details: { phoneLast4: phoneNumber.slice(-4) }
      });
    }
    return c.json({ error: 'Invalid verification code' }, 401);
  }

  // Update user with verified phone
  await db
    .update(users)
    .set({
      phoneNumber,
      phoneVerified: true,
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.phone.verify.confirmed',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { phoneLast4: phoneNumber.slice(-4) }
    });
  }

  return c.json({ success: true, message: 'Phone number verified' });
});

// SMS MFA enable (authenticated, requires verified phone)
phoneRoutes.post('/mfa/sms/enable', authMiddleware, async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');

  const [user] = await db
    .select({
      phoneNumber: users.phoneNumber,
      phoneVerified: users.phoneVerified,
      mfaEnabled: users.mfaEnabled
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (!user.phoneVerified || !user.phoneNumber) {
    return c.json({ error: 'Phone number must be verified before enabling SMS MFA' }, 400);
  }

  if (user.mfaEnabled) {
    return c.json({ error: 'MFA is already enabled. Disable it first to switch methods.' }, 400);
  }

  // Check org policy — is SMS allowed?
  if (auth.orgId) {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, auth.orgId))
      .limit(1);

    const orgSettings = org?.settings as { security?: { allowedMfaMethods?: { sms?: boolean } } } | null;
    if (orgSettings?.security?.allowedMfaMethods && !orgSettings.security.allowedMfaMethods.sms) {
      return c.json({ error: 'Your organization does not allow SMS MFA' }, 403);
    }
  }

  // Generate recovery codes
  const recoveryCodes = generateRecoveryCodes();

  // Enable SMS MFA
  await db
    .update(users)
    .set({
      mfaEnabled: true,
      mfaMethod: 'sms',
      mfaSecret: null,
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.mfa.setup',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: 'sms' }
    });
  }

  return c.json({ success: true, recoveryCodes, message: 'SMS MFA enabled successfully' });
});

// SMS MFA send code during login (unauthenticated, requires tempToken)
phoneRoutes.post('/mfa/sms/send', zValidator('json', smsSendSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const { tempToken } = c.req.valid('json');

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const twilio = getTwilioService();
  if (!twilio) {
    return c.json({ error: 'SMS service not configured' }, 501);
  }

  const pendingRaw = await redis.get(`mfa:pending:${tempToken}`);
  if (!pendingRaw) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }

  let userId: string;
  try {
    const parsed = JSON.parse(pendingRaw);
    userId = parsed.userId;
  } catch {
    return c.json({ error: 'Invalid MFA session data' }, 400);
  }

  // Look up phone number from DB (never store PII in Redis)
  const [smsUser] = await db
    .select({ phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const phoneNumber = smsUser?.phoneNumber;
  if (!phoneNumber) {
    return c.json({ error: 'No phone number configured for SMS MFA' }, 400);
  }

  // Rate limit per tempToken
  const tokenRate = await rateLimiter(
    redis,
    `sms:login-send:${tempToken}`,
    smsLoginSendLimiter.limit,
    smsLoginSendLimiter.windowSeconds
  );
  if (!tokenRate.allowed) {
    return c.json({ error: 'Too many SMS requests. Try again later.' }, 429);
  }

  // Rate limit per phone globally
  const phoneRate = await rateLimiter(
    redis,
    `sms:login-global:${phoneNumber}`,
    smsLoginGlobalLimiter.limit,
    smsLoginGlobalLimiter.windowSeconds
  );
  if (!phoneRate.allowed) {
    return c.json({ error: 'Too many SMS requests. Try again later.' }, 429);
  }

  const result = await twilio.sendVerificationCode(phoneNumber);
  if (!result.success) {
    return c.json({ error: 'Failed to send SMS code' }, 500);
  }

  const orgId = await resolveUserAuditOrgId(userId);
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.mfa.sms.sent',
      result: 'success',
      userId,
      details: { phoneLast4: phoneNumber.slice(-4) }
    });
  }

  return c.json({ success: true, message: 'SMS code sent' });
});
