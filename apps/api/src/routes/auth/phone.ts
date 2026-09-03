import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  generateRecoveryCodes,
  rateLimiter,
  getRedis,
  getUserEpochs,
  smsPhoneVerifyLimiter,
  smsPhoneVerifyUserLimiter,
  smsLoginSendLimiter,
  smsLoginGlobalLimiter,
  phoneConfirmLimiter,
  beginAuthIssuance,
  cancelAuthIssuance,
  bindIssuedUserSession,
  completeInitialMfaEnrollment,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  type AuthIssuanceCapability,
} from '../../services';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
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
  enforceExistingFactorStepUp,
  parsePendingMfa,
  evaluatePendingMfa,
  evaluatePendingMfaMethod,
  resolveCurrentUserTokenContext,
  auditUserLoginFailure,
  installAuthorizedUserSessionCookies,
  toPublicTokens,
  rejectProof,
  MFA_CODE_INVALID,
} from './helpers';

/**
 * #4470: same contract as `./mfa.ts` — these are SMS-factor proof endpoints and
 * a wrong code (or a wrong step-up password) is body data the server refused,
 * not a dead bearer. 401 here made the web client's generic 401 handler sign
 * the user out mid-enrollment. The `Invalid or expired MFA session` rejections
 * below KEEP their 401: the `tempToken` genuinely is the credential that
 * authenticates a pre-login request.
 */
const MFA_PROOF_REJECTION_STATUS = 400;
import { installAuthBindingReplacement, requestAuthBinding } from './binding';

const { db, withSystemDbAccessContext } = dbModule;

export const phoneRoutes = new Hono();

function authIssuanceAdmissionError(c: Context, error: unknown): Response | null {
  if (error instanceof AuthBindingRotationRequiredError) {
    installAuthBindingReplacement(c, error.replacement);
    return c.json({ error: error.message, reason: 'auth_binding_rotation_required' }, 428);
  }
  if (
    error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError
  ) {
    return c.json({ error: 'Authentication issuance unavailable' }, 409);
  }
  return null;
}

// Phone verification - send code (authenticated)
phoneRoutes.post('/phone/verify', authMiddleware, zValidator('json', phoneVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { phoneNumber, currentPassword } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd', {
    rejectionStatus: MFA_PROOF_REJECTION_STATUS,
  });
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

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd', {
    rejectionStatus: MFA_PROOF_REJECTION_STATUS,
  });
  if (passwordError) return passwordError;

  // SR2-20/C1: replacing/verifying the phone on an ALREADY-PROTECTED account is
  // a factor-affecting change and must additionally prove an existing factor —
  // otherwise a stolen access token + phished password could swap in the
  // attacker's number (which then satisfies the SMS step-up). No-op for initial
  // enrollment (no factor yet → password-only, per enforceExistingFactorStepUp).
  //
  // Two-phase, same idiom as passkeys register/options + register/verify:
  // validate (non-consuming) HERE so a missing/bogus/stale grant 403s before
  // the SMS code is even checked; consume BELOW, only once the code has proven
  // valid, so a fat-fingered code (or a 429/502 on the Twilio check) does not
  // destroy the user's single-use grant. (PR3 carry-forward.)
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: false });
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
    return rejectProof(c, 'Invalid verification code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
  }

  // Terminal phone write: NOW consume the grant (single-use). Re-checks the
  // binding against the LIVE epochs, so a factor change or session switch
  // between validate and consume invalidates it. A loss here (concurrent
  // consume of the same grant) fails CLOSED with the same 403 — the phone
  // number is not written.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpConsumeError) return stepUpConsumeError;

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

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd', {
    rejectionStatus: MFA_PROOF_REJECTION_STATUS,
  });
  if (passwordError) return passwordError;

  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof (no-op for initial enrollment).
  //
  // Two-phase (PR3 carry-forward): validate (non-consuming) HERE so a
  // missing/bogus/stale grant 403s before anything else runs; consume BELOW,
  // immediately before the terminal factor write, so a benign 400/403
  // (unverified phone, MFA already enabled, policy disallows SMS) does not
  // burn the user's single-use grant.
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: false });
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

  // Terminal factor write: NOW consume the grant (single-use). Re-checks the
  // binding against the LIVE epochs, so a factor change or session switch
  // between validate and consume invalidates it. A loss here (concurrent
  // consume of the same grant) fails CLOSED with the same 403 — the factor is
  // not written.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpConsumeError) return stepUpConsumeError;

  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodeHashes = hashRecoveryCodes(recoveryCodes);
  let capability: AuthIssuanceCapability;
  try {
    capability = await beginAuthIssuance(requestAuthBinding(c));
  } catch (error) {
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }
  let result;
  try {
    result = await completeInitialMfaEnrollment({
      userId: auth.user.id,
      identity: {
        userId: auth.user.id,
        email: auth.user.email,
        roleId: auth.token?.roleId ?? null,
        orgId: auth.orgId ?? null,
        partnerId: auth.partnerId ?? null,
        scope: auth.scope,
        mfa: true,
        mobileDeviceId: readMobileDeviceId(c) ?? undefined,
      },
      capability,
      expectedAuthEpoch: auth.token?.aep as number,
      expectedMfaEpoch: auth.token?.mep as number,
      revokeReason: 'sms-mfa-enable',
      recoveryCodes,
      recoveryCodeHashes,
      persistFactor: async (tx, hashes) => {
        const rows = await tx
          .update(users)
          .set({
            mfaEnabled: true,
            mfaMethod: 'sms',
            mfaSecret: null,
            mfaRecoveryCodes: [...hashes],
            updatedAt: new Date()
          })
          .where(eq(users.id, auth.user.id))
          .returning({ id: users.id });
        if (rows.length !== 1) throw new Error('MFA enrollment user disappeared');
        return undefined;
      },
    });
  } catch (error) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }
  await bindIssuedUserSession(result.issued);
  installAuthorizedUserSessionCookies(c, result.issued);

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'sms', mfaEpoch: result.mfaEpoch, teardownFailed: result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED }
  });

  return c.json({
    success: true,
    recoveryCodes: result.recoveryCodes,
    message: 'SMS MFA enabled successfully',
    tokens: toPublicTokens(result.issued),
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

  const pendingRaw = await redis.get(`mfa:pending:${tempToken}`);
  if (!pendingRaw) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }

  const pending = parsePendingMfa(pendingRaw);
  if (!pending) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  const userId = pending.userId;

  // Look up live factor/account state from DB (never store PII in Redis).
  // Pre-auth lookup — wrap in system scope so the `users` RLS policy
  // doesn't deny the read before the real request scope is applied.
  const [smsUser] = await withSystemDbAccessContext(async () =>
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        mfaEnabled: users.mfaEnabled,
        mfaMethod: users.mfaMethod,
        mfaSecret: users.mfaSecret,
        phoneNumber: users.phoneNumber,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );

  if (!smsUser) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }

  const liveEpochs = await getUserEpochs(userId);
  const pendingVerdict = liveEpochs
    ? evaluatePendingMfa(pending, {
        status: smsUser.status,
        authEpoch: liveEpochs.authEpoch,
        mfaEpoch: liveEpochs.mfaEpoch,
      })
    : ({ ok: false, reason: 'epoch_mismatch' } as const);
  if (!pendingVerdict.ok) {
    await redis.del(`mfa:pending:${tempToken}`);
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }

  const context = await resolveCurrentUserTokenContext(userId);
  const livePolicy = await getEffectiveMfaPolicy({
    scope: context.scope,
    userId,
    orgId: context.orgId,
    partnerId: context.partnerId,
  });
  const methodVerdict = evaluatePendingMfaMethod(
    pending,
    'sms',
    smsUser,
    livePolicy.allowedMethods,
  );
  if (!methodVerdict.ok) {
    if (methodVerdict.terminal) await redis.del(`mfa:pending:${tempToken}`);
    void auditUserLoginFailure(c, {
      userId,
      email: smsUser.email,
      name: smsUser.name,
      reason: 'mfa_method_not_allowed',
      details: { method: 'sms', phase: methodVerdict.reason, continuation: 'send' },
    });
    return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
  }
  const phoneNumber = smsUser.phoneNumber!;

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

  const twilio = getTwilioService();
  if (!twilio) {
    return c.json({ error: 'SMS service not configured' }, 501);
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
