import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  createTokenPair,
  generateMFASecret,
  consumeMFAToken,
  generateOTPAuthURL,
  generateQRCode,
  generateRecoveryCodes,
  rateLimiter,
  mfaLimiter,
  getRedis,
  mintRefreshTokenFamily,
  bindRefreshJtiToFamily,
  getUserEpochs
} from '../../services';
import { getTwilioService } from '../../services/twilio';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { authMiddleware } from '../../middleware/auth';
import { ENABLE_2FA, mfaVerifySchema, mfaEnableSchema, mfaStepUpSchema } from './schemas';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { mintStepUpGrant } from '../../services/mfaStepUpGrant';
import { verifyStepUpPasskeyAssertion } from './passkeys';
import {
  getClientIP,
  setRefreshTokenCookie,
  toPublicTokens,
  encryptMfaSecret,
  decryptMfaSecret,
  decryptMfaSecretForMigration,
  hashRecoveryCode,
  hashRecoveryCodes,
  mfaDisabledResponse,
  resolveCurrentUserTokenContext,
  resolveUserAuditOrgId,
  writeAuthAudit,
  auditUserLoginFailure,
  auditLogin,
  userRequiresSetup,
  requireCurrentPasswordStepUp,
  enforceExistingFactorStepUp,
  parsePendingMfa,
  evaluatePendingMfa,
  mintLoginRegisterGrant
} from './helpers';

const { db, withSystemDbAccessContext, runOutsideDbContext } = dbModule;

// Body schemas that require a password re-prompt. A stolen access token
// must not be sufficient to install/remove an MFA factor — these
// endpoints always re-verify the user's current password against the
// argon2 hash, rate-limited per user to blunt online password guessing.
const passwordOnlySchema = z.object({
  currentPassword: z.string().min(1).max(256)
});
const mfaEnableWithPasswordSchema = mfaEnableSchema.extend({
  currentPassword: z.string().min(1).max(256),
  // SR2-20: existing-factor step-up grant required when the account is
  // already MFA-protected (see enforceExistingFactorStepUp in ./helpers).
  stepUpGrantId: z.string().optional()
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

  const { code, tempToken, method } = c.req.valid('json');
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

    // SR2-06: strict parse — legacy bare-userId / epoch-less records return
    // null and must force a fresh login rather than complete with no live
    // re-check of the account's current epoch/status.
    const pending = parsePendingMfa(pendingRaw);
    if (!pending) {
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }
    const pendingUserId = pending.userId;
    const pendingMfaMethod = pending.mfaMethod;

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

    // SR2-06: re-check the live epoch/status before minting. A factor change
    // (mfa_epoch), an account-wide security event (auth_epoch), or a suspend
    // during the 5-minute MFA window must invalidate this in-flight session.
    const liveEpochs = await getUserEpochs(user.id);
    const verdict = liveEpochs
      ? evaluatePendingMfa(pending, { status: user.status, authEpoch: liveEpochs.authEpoch, mfaEpoch: liveEpochs.mfaEpoch })
      : ({ ok: false, reason: 'epoch_mismatch' } as const);
    if (!verdict.ok) {
      // Consume the record so a rejected session can't be retried.
      await redis.del(`mfa:pending:${tempToken}`);
      void auditUserLoginFailure(c, {
        userId: user.id, email: user.email, name: user.name,
        reason: 'mfa_pending_invalidated',
        details: { phase: verdict.reason, method: pendingMfaMethod },
      });
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }

    // Resolve the user's token context ONCE (reused for the mint below, which
    // no longer re-resolves it further down).
    const mfaContext = await resolveCurrentUserTokenContext(user.id);

    // Method must still be allowed by current policy (a factor could have been
    // disallowed since login). Passkey is handled by its own route; here we gate
    // totp/sms. Use the real scope/org/partner from the resolved context so
    // org- and partner-scoped policy resolves correctly.
    const livePolicy = await getEffectiveMfaPolicy({
      scope: mfaContext.scope,
      userId: user.id,
      orgId: mfaContext.orgId,
      partnerId: mfaContext.partnerId,
    });
    if ((pendingMfaMethod === 'sms' && !livePolicy.allowedMethods.sms) ||
        (pendingMfaMethod === 'totp' && !livePolicy.allowedMethods.totp)) {
      await redis.del(`mfa:pending:${tempToken}`);
      void auditUserLoginFailure(c, {
        userId: user.id, email: user.email, name: user.name,
        reason: 'mfa_method_not_allowed', details: { method: pendingMfaMethod },
      });
      return c.json({ error: 'This MFA method is no longer permitted. Please sign in again.' }, 401);
    }

    // Use the server-stored method only — never allow the client to override
    const effectiveMethod = pendingMfaMethod;

    let valid = false;
    let migratedMfaSecret: string | null = null;
    if (effectiveMethod === 'passkey') {
      return c.json({ error: 'Use passkey verification for this MFA session' }, 400);
    }

    // Recovery-code login. Independent of the account's primary factor: a user
    // locked out of their authenticator falls back to a stored recovery code.
    // Remove exactly one matching hash with a server-side RELATIVE jsonb delete
    // (`mfaRecoveryCodes - inputHash`) guarded by `@> [inputHash]`. This is the
    // ONLY correct concurrency shape — it composes under READ COMMITTED:
    //   - two concurrent DISTINCT valid codes each delete their OWN element from
    //     the row's committed value (Postgres re-evaluates `-` against the
    //     latest committed array), so both succeed and NEITHER resurrects the
    //     other's hash. A stale read-modify-write (SET = a JS array computed
    //     from a pre-read snapshot) would resurrect the co-winner's hash — never
    //     do that.
    //   - two concurrent IDENTICAL codes serialize on the row; the loser's `@>`
    //     guard fails against the winner's committed value → rowCount 0 → 401.
    // Single-winner AND no-resurrection are proven against real Postgres (Task 9).
    if (method === 'recovery') {
      const inputHash = hashRecoveryCode(code);
      const stored = Array.isArray(user.mfaRecoveryCodes) ? (user.mfaRecoveryCodes as string[]) : [];
      if (!stored.includes(inputHash)) {
        void auditUserLoginFailure(c, {
          userId: user.id, email: user.email, name: user.name,
          reason: 'mfa_recovery_code_invalid', details: { method: 'recovery' },
        });
        return c.json({ error: 'Invalid MFA code' }, 401);
      }
      const removed = await withSystemDbAccessContext(() =>
        db
          .update(users)
          .set({ mfaRecoveryCodes: sql`${users.mfaRecoveryCodes} - ${inputHash}`, updatedAt: new Date() })
          .where(and(eq(users.id, user.id), sql`${users.mfaRecoveryCodes} @> ${JSON.stringify([inputHash])}::jsonb`))
          .returning({ id: users.id }),
      );
      if (removed.length === 0) {
        // A concurrent winner already consumed this exact hash — reject the loser.
        return c.json({ error: 'Invalid MFA code' }, 401);
      }
      writeAuthAudit(c, {
        orgId: undefined,
        action: 'auth.mfa.recovery_code.used',
        result: 'success',
        userId: user.id,
        email: user.email,
        // Best-effort count from the PRE-update snapshot only — never read the
        // post-update array back, and never log the code or its hash.
        details: { remainingApprox: Math.max(0, stored.length - 1) },
      });
      valid = true;
    } else if (effectiveMethod === 'sms') {
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

    // Clear temp token
    await redis.del(`mfa:pending:${tempToken}`);

    // Partner/org context was already resolved above (mfaContext) — reuse it
    // rather than re-querying.
    const mfaRoleId = mfaContext.roleId;
    const mfaPartnerId = mfaContext.partnerId;
    const mfaOrgId = mfaContext.orgId;
    const mfaScope = mfaContext.scope;

    // Create tokens with user's context. Mint a fresh refresh-token family
    // so MFA-completed logins get the same reuse-detection guarantees as
    // password-only logins. Missing this on /mfa/verify would silently
    // exempt every MFA-enabled user from RFC 9700 §4.13.2 protection —
    // exactly the wrong cohort to skip.
    const mfaFamilyId = await mintRefreshTokenFamily(user.id);
    const epochs = await getUserEpochs(user.id);
    if (!epochs) throw new Error('user epochs unavailable at token mint');
    const tokens = await createTokenPair({
      sub: user.id,
      email: user.email,
      roleId: mfaRoleId,
      orgId: mfaOrgId,
      partnerId: mfaPartnerId,
      scope: mfaScope,
      mfa: true,
      aep: epochs.authEpoch,
      mep: epochs.mfaEpoch,
      // SR-001: bind to the mobile install id when present (MFA login path).
      mdid: readMobileDeviceId(c) ?? undefined
    }, { refreshFam: mfaFamilyId });

    await bindRefreshJtiToFamily(tokens.refreshJti, mfaFamilyId);

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
        .where(eq(users.id, user.id))
    );

    auditLogin(c, { orgId: mfaOrgId ?? null, userId: user.id, email: user.email, name: user.name, mfa: true, scope: mfaScope, ip: getClientIP(c) });

    setRefreshTokenCookie(c, tokens.refreshToken);

    const requiresSetup = userRequiresSetup(user);

    // #2707: mobile-only best-effort mint of a register_approver_device
    // grant — same rationale as the /auth/login no-MFA success response.
    const authenticatorRegisterGrantId = await mintLoginRegisterGrant(c, user.id, mfaFamilyId);

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: true,
        avatarUrl: user.avatarUrl,
        // Mirrors the password-login payload — the auth store is seeded from
        // whichever of the two completes the login, and the sidebar gates
        // platform-admin-only nav on this flag.
        isPlatformAdmin: user.isPlatformAdmin === true
      },
      tokens: toPublicTokens(tokens),
      mfaRequired: false,
      requiresSetup,
      ...(authenticatorRegisterGrantId ? { authenticatorRegisterGrantId } : {})
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
  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof (no-op for initial enrollment).
  //
  // Two-phase, same idiom as passkeys register/options + register/verify:
  //   validate (non-consuming) HERE, so a missing/bogus/stale grant 403s
  //   before the consuming TOTP verifier burns the setup time-step (M10);
  //   consume BELOW, only once the code itself has proven valid, so a
  //   fat-fingered 6-digit code does not destroy the user's single-use grant
  //   and force them back through /auth/mfa/step-up. (PR3 carry-forward.)
  const stepUpGrantId = c.req.valid('json').stepUpGrantId;
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: false });
  if (stepUpError) return stepUpError;

  // Consuming verifier: record the accepted time step so it cannot be replayed
  // at login within its ~90s validity window (SR2-24). Fails closed if Redis is
  // down (consumeMFAToken returns false).
  const valid = await consumeMFAToken(secret, code, auth.user.id);

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

  // Terminal factor write: NOW consume the grant (single-use). Re-checks the
  // binding against the LIVE epochs, so a factor change or session switch
  // between validate and consume invalidates it. A loss here (concurrent
  // consume of the same grant) fails CLOSED with the same 403 — the factor is
  // not written.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpConsumeError) return stepUpConsumeError;

  // SR2-07/SR2-19: fold the factor write into the atomic epoch-bump +
  // refresh-family-revoke transaction, then best-effort post-commit cleanup +
  // remote-session teardown — enabling MFA is a security-relevant factor
  // change and must invalidate any assurance minted before this factor
  // existed.
  //
  // I3: unlike every other factor-change caller, this Case-2 path has NO
  // ambient DB access context — the `await authMiddleware(c, async () => {})`
  // idiom above tears the RLS context down when its empty `next` returns. So
  // establish a real system context here; without it the invalidation
  // transaction runs on the bare pool, forced RLS matches 0 rows, and
  // advanceUserEpochs throws → hard 500 with the factor never enabled.
  const result = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'mfa-setup-confirm', async (tx) => {
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
      })
    )
  );

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: setupOrgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp', mfaEpoch: result.mfaEpoch, teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED }
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

  // MFA policy blocks self-disable when effective policy (role OR org/partner
  // requireMfa, partner-inherited) still requires MFA for this user. Uses the
  // resolver so a partner-set requireMfa — invisible to the old org-only read
  // — is honored, and partner-scope users are covered (I3, SR2-05).
  const disablePolicy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  }, { failClosed: true });
  if (disablePolicy.required) {
    return c.json({ error: 'Your organization requires MFA. Contact your admin to change this policy.' }, 403);
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
    // consumeMFAToken: a replayed live code must not disable MFA. (sec review #2)
    const valid = await consumeMFAToken(decryptedMfaSecret, code, auth.user.id);
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

  const result = await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'mfa-disable', async (tx) => {
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
  });

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.disable',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: currentMethod, mfaEpoch: result.mfaEpoch, teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED }
  });

  return c.json({ success: true, message: 'MFA disabled successfully' });
});

// MFA enable compatibility endpoint for frontend settings flow
mfaRoutes.post('/mfa/enable', authMiddleware, zValidator('json', mfaEnableWithPasswordSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { code, currentPassword, stepUpGrantId } = c.req.valid('json');

  // Re-verify password before flipping mfaEnabled=true on the user row.
  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd');
  if (passwordError) return passwordError;

  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof (no-op for initial enrollment).
  //
  // Two-phase, same idiom as passkeys register/options + register/verify:
  //   validate (non-consuming) HERE, so a missing/bogus/stale grant 403s
  //   before the consuming TOTP verifier burns the setup time-step;
  //   consume BELOW, only once the code itself has proven valid, so a
  //   fat-fingered 6-digit code does not destroy the user's single-use grant
  //   and force them back through /auth/mfa/step-up. (PR3 carry-forward.)
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: false });
  if (stepUpError) return stepUpError;

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

  // Consuming verifier: record the accepted time step so it cannot be replayed
  // at login within its ~90s validity window (SR2-24). Fails closed if Redis is
  // down (consumeMFAToken returns false).
  const valid = await consumeMFAToken(secret, code, auth.user.id);
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

  // Terminal factor write: NOW consume the grant (single-use). Re-checks the
  // binding against the LIVE epochs, so a factor change or session switch
  // between validate and consume invalidates it. A loss here (concurrent
  // consume of the same grant) fails CLOSED with the same 403 — the factor is
  // not written.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpConsumeError) return stepUpConsumeError;

  const result = await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'mfa-enable', async (tx) => {
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
  });

  await redis.del(`mfa:setup:${auth.user.id}`);

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: setupOrgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp', mfaEpoch: result.mfaEpoch, teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED }
  });

  return c.json({ success: true, recoveryCodes, message: 'MFA enabled successfully' });
});

// SR2-20: existing-factor step-up. Proves an EXISTING MFA factor (TOTP, SMS,
// or passkey — a discriminated union on `method` so a passkey-only user is
// never locked out) and mints a short-lived single-use grant scoped to the
// requested operation (defaulting to add_factor; #2707 adds register_approver_device),
// which the caller then presents as `stepUpGrantId` to a factor-ADDITION endpoint
// (`/mfa/enable`, setup-confirm, `/mfa/sms/enable`, `/passkeys/register/*`)
// on an already-protected account. The passkey branch expects the client to
// have already called `POST /auth/mfa/step-up/options` (passkeys.ts) to get
// a fresh WebAuthn challenge.
mfaRoutes.post('/mfa/step-up', authMiddleware, zValidator('json', mfaStepUpSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const body = c.req.valid('json');

  // Rate-limit per user (I2). Every other MFA-verification endpoint throttles
  // per user; without this the only bound is the 300/60s-per-IP global limit,
  // leaving a 6-digit TOTP / SMS code brute-forceable to a step-up grant across
  // a handful of IPs. Fail closed (503) when Redis is unavailable.
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  // Key prefix `mfa:stepup-rl:` is deliberately disjoint from the grant store's
  // `mfa:stepup:` (mfaStepUpGrant.ts) so the rate-limiter's sorted-set never
  // shares a namespace with a grant key.
  const stepUpRate = await rateLimiter(redis, `mfa:stepup-rl:${auth.user.id}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
  if (!stepUpRate.allowed) {
    return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
  }

  let ok = false;
  if (body.method === 'totp') {
    const [u] = await db.select({ mfaSecret: users.mfaSecret }).from(users).where(eq(users.id, auth.user.id)).limit(1);
    const secret = u?.mfaSecret ? decryptMfaSecret(u.mfaSecret) : null;
    ok = !!secret && await consumeMFAToken(secret, body.code, auth.user.id);
  } else if (body.method === 'sms') {
    // Step-up must prove the account's OWN active SMS factor — not merely that
    // some phone number sits on the row. Allowlist on mfaEnabled + mfaMethod +
    // phoneVerified (mirrors requireFreshMfaStepUp's TOTP allowlist). Without
    // this, an attacker who swapped in their own phone via /phone/confirm could
    // mint a grant here without ever proving the victim's real factor (C1).
    const [u] = await db
      .select({
        phoneNumber: users.phoneNumber,
        mfaEnabled: users.mfaEnabled,
        mfaMethod: users.mfaMethod,
        phoneVerified: users.phoneVerified,
      })
      .from(users)
      .where(eq(users.id, auth.user.id))
      .limit(1);
    if (!u?.mfaEnabled || u.mfaMethod !== 'sms' || u.phoneVerified !== true || !u.phoneNumber) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    const twilio = getTwilioService();
    if (!twilio) return c.json({ error: 'SMS not available' }, 400);
    const r = await twilio.checkVerificationCode(u.phoneNumber, body.code);
    if (r.serviceError) return c.json({ error: 'SMS verification temporarily unavailable' }, 502);
    ok = r.valid;
  } else {
    // passkey — client must have already called POST /auth/mfa/step-up/options.
    ok = await verifyStepUpPasskeyAssertion(auth.user.id, body.credential);
  }

  if (!ok) {
    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.mfa.stepup.failed',
      result: 'failure',
      reason: 'invalid_factor',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: body.method }
    });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const epochs = await getUserEpochs(auth.user.id);
  if (!epochs || !auth.token.sid) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const grantId = await mintStepUpGrant({
    userId: auth.user.id,
    operation: body.operation,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid: auth.token.sid
  });
  if (!grantId) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.stepup.granted',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: body.method, operation: body.operation }
  });

  return c.json({ stepUpGrantId: grantId });
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
  // Rotating recovery codes advances mfa_epoch and signs the user out — per
  // SR2-19 this is intended: the recovery-code set is part of the MFA config,
  // and a stale set otherwise remains usable after rotation from a stolen
  // session.
  const result = await invalidateMfaAssuranceAfterFactorChange(auth.user.id, 'mfa-recovery-rotate', async (tx) => {
    await tx
      .update(users)
      .set({
        mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
        updatedAt: new Date()
      })
      .where(eq(users.id, auth.user.id));
  });

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'auth.mfa.recovery_codes.rotate',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { count: recoveryCodes.length, mfaEpoch: result.mfaEpoch, teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED }
  });

  return c.json({ success: true, recoveryCodes, message: 'Recovery codes generated successfully' });
});
