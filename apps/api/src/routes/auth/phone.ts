import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
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
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { authMiddleware } from '../../middleware/auth';
import { ENABLE_2FA, phoneVerifySchema, phoneConfirmSchema, smsSendSchema, smsMfaEnableSchema } from './schemas';
import {
  mfaDisabledResponse,
  hashRecoveryCodes,
  resolveUserAuditOrgId,
  writeAuthAudit,
  requireCurrentPasswordStepUp,
  enforceExistingFactorStepUp
} from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

export const phoneRoutes = new Hono();

// Phone verification - send code (authenticated)
phoneRoutes.post('/phone/verify', authMiddleware, zValidator('json', phoneVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { phoneNumber, currentPassword } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

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
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.phone.verify.requested',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { phoneLast4: phoneNumber.slice(-4) }
  });

  return c.json({ success: true, message: 'Verification code sent' });
});

// Phone verification - confirm code (authenticated)
phoneRoutes.post('/phone/confirm', authMiddleware, zValidator('json', phoneConfirmSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { phoneNumber, code, currentPassword, stepUpGrantId } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  // SR2-20/C1: replacing/verifying the phone on an ALREADY-PROTECTED account is
  // a factor-affecting change and must additionally prove an existing factor —
  // otherwise a stolen access token + phished password could swap in the
  // attacker's number (which then satisfies the SMS step-up). No-op for initial
  // enrollment (no factor yet → password-only, per enforceExistingFactorStepUp).
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpError) return stepUpError;

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
    writeAuthAudit(c, {
      orgId: orgId ?? undefined,
      action: 'auth.phone.verify.failed',
      result: 'failure',
      reason: 'invalid_code',
      userId: auth.user.id,
      email: auth.user.email,
      details: { phoneLast4: phoneNumber.slice(-4) }
    });
    return c.json({ error: 'Invalid verification code' }, 401);
  }

  // Replacement-only invalidation: initial SMS phone verification (before
  // /mfa/sms/enable has ever run) must NOT sign the user out mid-flow — they
  // still need to complete enrollment. Only a phone number REPLACEMENT behind
  // an already-ACTIVE SMS factor is a security-relevant factor change (the
  // old number could otherwise keep receiving MFA codes for a session that
  // predates the swap), so only that case invalidates assurance.
  const [cur] = await db
    .select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  const isSmsFactorReplacement = cur?.mfaEnabled === true && cur.mfaMethod === 'sms';

  let assuranceResult: Awaited<ReturnType<typeof invalidateMfaAssuranceAfterFactorChange>> | null = null;
  if (isSmsFactorReplacement) {
    assuranceResult = await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'phone-replacement', async (tx) => {
      await tx
        .update(users)
        .set({ phoneNumber, phoneVerified: true, updatedAt: new Date() })
        .where(eq(users.id, auth.user.id));
    });
  } else {
    await db
      .update(users)
      .set({ phoneNumber, phoneVerified: true, updatedAt: new Date() })
      .where(eq(users.id, auth.user.id));
  }

  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.phone.verify.confirmed',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: {
      phoneLast4: phoneNumber.slice(-4),
      ...(assuranceResult
        ? {
            smsFactorReplacement: true,
            mfaEpoch: assuranceResult.mfaEpoch,
            teardownFailed: assuranceResult.remoteSessionsTerminated === TEARDOWN_FAILED
          }
        : {})
    }
  });

  return c.json({ success: true, message: 'Phone number verified' });
});

// SMS MFA enable (authenticated, requires verified phone)
phoneRoutes.post('/mfa/sms/enable', authMiddleware, zValidator('json', smsMfaEnableSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword, stepUpGrantId } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof (no-op for initial enrollment).
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpError) return stepUpError;

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

  // Enforce the CANONICAL allowlist through the resolver (partner-inherited).
  // The old reader consulted `security.allowedMfaMethods`, a spelling that is
  // written nowhere → the SMS restriction silently no-opped. Passkey is always
  // allowed; only totp/sms are gated by effective settings.
  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  });
  if (!policy.allowedMethods.sms) {
    return c.json({ error: 'Your organization does not allow SMS MFA' }, 403);
  }

  // Generate recovery codes
  const recoveryCodes = generateRecoveryCodes();

  // Enable SMS MFA
  const result = await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'sms-mfa-enable', async (tx) => {
    await tx
      .update(users)
      .set({
        mfaEnabled: true,
        mfaMethod: 'sms',
        mfaSecret: null,
        mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
        updatedAt: new Date()
      })
      .where(eq(users.id, auth.user.id));
  });

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'sms', mfaEpoch: result.mfaEpoch, teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED }
  });

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

  // Look up phone number from DB (never store PII in Redis).
  // Pre-auth lookup — wrap in system scope so the `users` RLS policy
  // doesn't deny the read before the real request scope is applied.
  const [smsUser] = await withSystemDbAccessContext(async () =>
    db
      .select({ phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );

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
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.sms.sent',
    result: 'success',
    userId,
    details: { phoneLast4: phoneNumber.slice(-4) }
  });

  return c.json({ success: true, message: 'SMS code sent' });
});
