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
  phoneConfirmLimiter,
  PendingMfaUnavailableError,
  readPendingMfa,
} from '../../services';
import { getTwilioService } from '../../services/twilio';
import { authMiddleware } from '../../middleware/auth';
import { ENABLE_2FA, phoneVerifySchema, phoneConfirmSchema, smsSendSchema, smsMfaEnableSchema } from './schemas';
import {
  mfaDisabledResponse,
  hashRecoveryCodes,
  resolveUserAuditOrgId,
  writeAuthAudit,
  requireCurrentPasswordStepUp,
  consumeMfaStepUpGrant,
  readMfaStepUpGrant,
  MfaStepUpGrantInvalidError,
  MfaStepUpGrantUnavailableError,
} from './helpers';
import {
  cleanupMfaAssuranceUsers,
  MfaAssuranceMutationStaleError,
  runLockedMfaMutation,
} from '../../services/mfaAssuranceMutation';
import { invalidateUserMfaAssurance, withAuthLifecycleSystemTransaction } from '../../services/authLifecycle';
import { lockMfaAssuranceState } from '../../services/mfaAssuranceLocks';
import { resolveEffectiveMfaPolicy } from '../../services/mfaPolicy';

const { db, withSystemDbAccessContext } = dbModule;

export const phoneRoutes = new Hono();

function mutationInput(auth: any, reason: string) {
  if (!Number.isSafeInteger(auth.token.ae) || !Number.isSafeInteger(auth.token.me)) {
    throw new MfaAssuranceMutationStaleError();
  }
  return {
    userId: auth.user.id,
    partnerId: auth.token.partnerId,
    authEpoch: auth.token.ae,
    mfaEpoch: auth.token.me,
    reason,
  };
}

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
  const { phoneNumber, code, currentPassword, mfaGrant } = c.req.valid('json');

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

  let requiresReauthentication = false;
  try {
    await withAuthLifecycleSystemTransaction(async (tx) => {
      const locked = await lockMfaAssuranceState(tx, {
        partnerId: auth.token.partnerId,
        userId: auth.user.id,
      });
      if (!locked.user
        || locked.user.status !== 'active'
        || locked.user.authEpoch !== auth.token.ae
        || locked.user.mfaEpoch !== auth.token.me) {
        throw new MfaAssuranceMutationStaleError();
      }
      requiresReauthentication = locked.user.mfaEnabled === true
        && locked.user.mfaMethod === 'sms'
        && locked.user.phoneVerified === true
        && locked.user.phoneNumber !== phoneNumber;
      if (requiresReauthentication) {
        if (!mfaGrant) throw new Error('MFA_PROOF_REQUIRED');
        const sessionId = auth.token.sid;
        if (!sessionId) throw new MfaAssuranceMutationStaleError();
        const binding = {
          purpose: 'sms.replace' as const,
          userId: auth.user.id,
          sessionId,
          authEpoch: auth.token.ae,
          mfaEpoch: auth.token.me,
        };
        const policy = await resolveEffectiveMfaPolicy({
          userId: auth.user.id,
          roleId: auth.token.roleId,
          orgId: auth.token.orgId,
          partnerId: auth.token.partnerId,
          scope: auth.token.scope,
          tx,
        });
        const grant = await readMfaStepUpGrant(mfaGrant, binding);
        const existingMethodAllowed = grant.verifiedMethod === 'passkey'
          ? locked.activePasskeyCount > 0 && policy.allowedMethods.has('passkey')
          : grant.verifiedMethod === 'totp'
            ? Boolean(locked.user.mfaSecret) && policy.allowedMethods.has('totp')
            : locked.user.mfaMethod === 'sms'
              && locked.user.phoneVerified === true
              && Boolean(locked.user.phoneNumber)
              && policy.allowedMethods.has('sms');
        if (!existingMethodAllowed) throw new Error('MFA_PROOF_REQUIRED');
        await consumeMfaStepUpGrant(mfaGrant, {
          ...binding,
          verifiedMethod: grant.verifiedMethod,
        });
      }
      await tx
        .update(users)
        .set({ phoneNumber, phoneVerified: true, updatedAt: new Date() })
        .where(eq(users.id, auth.user.id));
      if (requiresReauthentication) {
        await invalidateUserMfaAssurance(tx, auth.user.id, 'sms-phone-replaced');
      }
    });
  } catch (error) {
    if (error instanceof MfaAssuranceMutationStaleError) {
      return c.json({ error: 'Authentication state changed. Please sign in again.' }, 401);
    }
    if (error instanceof Error && error.message === 'MFA_PROOF_REQUIRED') {
      return c.json({ error: 'Existing MFA factor proof is required to replace the SMS phone' }, 403);
    }
    if (error instanceof MfaStepUpGrantInvalidError) {
      return c.json({ error: 'Invalid or expired MFA step-up authorization' }, 401);
    }
    if (error instanceof MfaStepUpGrantUnavailableError) {
      return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
    }
    throw error;
  }
  const cleanup = requiresReauthentication
    ? await cleanupMfaAssuranceUsers([auth.user.id])
    : { cleanupStatus: 'complete' as const, cleanupFailures: [] as string[] };

  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.phone.verify.confirmed',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { phoneLast4: phoneNumber.slice(-4) }
  });

  return c.json({
    success: true,
    ...(requiresReauthentication ? { reauthenticate: true } : {}),
    message: 'Phone number verified',
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
});

// SMS MFA enable (authenticated, requires verified phone)
phoneRoutes.post('/mfa/sms/enable', authMiddleware, zValidator('json', smsMfaEnableSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  // Generate recovery codes
  const recoveryCodes = generateRecoveryCodes();
  try {
    await runLockedMfaMutation(mutationInput(auth, 'sms-factor-enabled'), async (tx, locked) => {
      const user = locked.user!;
      if (!user.phoneVerified || !user.phoneNumber) {
        throw new Error('PHONE_NOT_VERIFIED');
      }
      if (user.mfaEnabled) throw new Error('MFA_ALREADY_ENABLED');
      const policy = await resolveEffectiveMfaPolicy({
        userId: auth.user.id,
        roleId: auth.token.roleId,
        orgId: auth.token.orgId,
        partnerId: auth.token.partnerId,
        scope: auth.token.scope,
        tx,
      });
      if (!policy.allowedMethods.has('sms')) throw new Error('SMS_NOT_ALLOWED');
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
  } catch (error) {
    if (error instanceof MfaAssuranceMutationStaleError) {
      return c.json({ error: 'Authentication state changed. Please sign in again.' }, 401);
    }
    if (error instanceof Error && error.message === 'PHONE_NOT_VERIFIED') {
      return c.json({ error: 'Phone number must be verified before enabling SMS MFA' }, 400);
    }
    if (error instanceof Error && error.message === 'MFA_ALREADY_ENABLED') {
      return c.json({ error: 'MFA is already enabled. Disable it first to switch methods.' }, 400);
    }
    if (error instanceof Error && error.message === 'SMS_NOT_ALLOWED') {
      return c.json({ error: 'Your effective MFA policy does not allow SMS MFA' }, 403);
    }
    throw error;
  }
  const cleanup = await cleanupMfaAssuranceUsers([auth.user.id]);

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'sms' }
  });

  return c.json({
    success: true,
    reauthenticate: true,
    recoveryCodes,
    message: 'SMS MFA enabled successfully',
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
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

  let pending;
  try {
    pending = await readPendingMfa(tempToken);
  } catch (error) {
    if (error instanceof PendingMfaUnavailableError) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    throw error;
  }
  if (!pending) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  if (!pending.allowedMethods.includes('sms') || !pending.enrolledMethods.includes('sms')) {
    return c.json({ error: 'SMS MFA is not configured for this session' }, 400);
  }
  const userId = pending.userId;

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
