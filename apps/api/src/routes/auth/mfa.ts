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
  getUserEpochs,
  beginAuthIssuance,
  finishAuthIssuance,
  cancelAuthIssuance,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  issueUserSession,
  completeInitialMfaEnrollment,
  issueUserSessionLegacyDuringTransition,
  bindIssuedUserSession,
  authBrowserTransitionsEnforced,
  recordAuthTransitionLegacyIssuer,
  consumeRecoveryCode,
  RecoveryCodeInvalidError,
  type AuthIssuanceCapability,
  type AuthorizedUserSession,
  type UserSessionIdentity,
} from '../../services';
import { getTwilioService } from '../../services/twilio';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import { ENABLE_2FA, mfaVerifySchema, mfaEnableSchema, mfaStepUpSchema } from './schemas';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { mintStepUpGrant, rollbackResourceDigest } from '../../services/mfaStepUpGrant';
import { verifyStepUpPasskeyAssertion } from './passkeys';
import {
  getClientIP,
  installAuthorizedUserSessionCookies,
  installLegacyUserSessionCookiesDuringTransition,
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
  requireCurrentPasswordStepUp,
  resolveEnrollmentStepUp,
  enforceExistingFactorStepUp,
  parsePendingMfa,
  evaluatePendingMfa,
  evaluatePendingMfaMethod,
  rejectProof,
  MFA_CODE_INVALID,
  MFA_PROOF_INVALID,
  mintLoginRegisterGrant,
  isAuthTransitionV1Request,
  authClientUpgradeRequiredResponse,
} from './helpers';
import { installAuthBindingReplacement, requestAuthBinding } from './binding';

import { finalizeSsoPendingLink } from './ssoLinkCompletion';

const { db, withSystemDbAccessContext, runOutsideDbContext } = dbModule;

/**
 * #4470: every rejected proof on these routes answers 400, never 401.
 *
 * A wrong TOTP/SMS/recovery code — or a wrong step-up password — is the user
 * mistyping a field of the request body. The bearer that authenticated the
 * request is still perfectly valid. Answering 401 made the two
 * indistinguishable to the clients, and `fetchWithAuth`
 * (`apps/web/src/stores/auth.ts`) turns a 401 into refresh-and-replay and then
 * `handleSessionExpired` — so a single typo signed the user out in the middle
 * of MFA enrollment (#4413/#4414).
 *
 * 401 survives on these routes for exactly two things, both of which really
 * ARE "the credential authenticating this request is dead":
 *   - the bearer guard (`authMiddleware`), and
 *   - the login challenge's `tempToken` (`Invalid or expired MFA session`) and
 *     the SSO-link ceremony (`sso_link_expired`) — the login page keys on
 *     those to send the user back to the start instead of asking for another
 *     code.
 */
const MFA_PROOF_REJECTION_STATUS = 400;

function authTransitionClientClass(c: Context): 'web' | 'native' {
  return readMobileDeviceId(c) ? 'native' : 'web';
}

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

async function enforceTotpEnrollmentPolicy(c: Context, auth: AuthContext): Promise<Response | null> {
  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  }, { failClosed: true });
  if (!policy.allowedMethods.totp) {
    return c.json({ error: 'Your organization does not allow authenticator-app MFA' }, 403);
  }
  return null;
}

// Body schemas that require a password re-prompt. A stolen access token
// must not be sufficient to install/remove an MFA factor — these
// endpoints always re-verify the user's current password against the
// argon2 hash, rate-limited per user to blunt online password guessing.
const passwordOnlySchema = z.object({
  currentPassword: z.string().min(1).max(256)
});

// #4018: the FIRST-FACTOR ENROLLMENT endpoints accept either proof. Both are
// optional HERE and resolveEnrollmentStepUp decides which road this account is
// allowed to take — "neither supplied" must be that helper's own opaque
// rejection, not a zod rejection from this schema, because the shape of the
// rejection must not tell an attacker whether the account has a password.
// (#4470 moved that rejection's status from 401 to 400 on these routes; the
// point stands unchanged — it is the UNIFORMITY that closes the oracle, not
// the particular status.) `passwordOnlySchema` above stays password-only:
// /mfa/recovery-codes is not an enrollment.
const enrollmentStepUpSchema = z.object({
  currentPassword: z.string().min(1).max(256).optional(),
  ssoReauthGrantId: z.string().uuid().optional()
});
const mfaEnableWithStepUpSchema = mfaEnableSchema.extend({
  currentPassword: z.string().min(1).max(256).optional(),
  ssoReauthGrantId: z.string().uuid().optional(),
  // SR2-20: existing-factor step-up grant required when the account is
  // already MFA-protected (see enforceExistingFactorStepUp in ./helpers).
  stepUpGrantId: z.string().optional()
});
const mfaDisableSchema = mfaVerifySchema.extend({
  currentPassword: z.string().min(1).max(256)
});

export const mfaRoutes = new Hono();

// Forced-enrollment discovery. This path is intentionally under /auth/mfa/*,
// which authMiddleware exempts from the normal 428 enrollment gate.
mfaRoutes.get('/mfa/enrollment-options', authMiddleware, async (c) => {
  if (!ENABLE_2FA) return mfaDisabledResponse(c);

  const auth = c.get('auth');
  const [user] = await db
    .select({ phoneNumber: users.phoneNumber, phoneVerified: users.phoneVerified })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  if (!user) return c.json({ error: 'User not found' }, 404);

  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  }, { failClosed: true });

  return c.json({
    allowedMethods: policy.allowedMethods,
    phoneConfigured: user.phoneVerified === true && Boolean(user.phoneNumber),
  });
});

// MFA setup (requires auth + current-password re-prompt)
mfaRoutes.post('/mfa/setup', authMiddleware, zValidator('json', enrollmentStepUpSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword, ssoReauthGrantId } = c.req.valid('json');
  const policyError = await enforceTotpEnrollmentPolicy(c, auth);
  if (policyError) return policyError;

  // Re-verify identity before allowing MFA factor installation. A stolen
  // access token is not sufficient — the user must prove possession of the
  // password, or (passwordless SSO accounts only, #4018) present a grant from
  // a fresh forced re-authentication at their IdP.
  //
  // NON-consuming: this endpoint only stashes a candidate secret in Redis. The
  // single-use burn happens at the terminal factor write that confirms it
  // (/mfa/verify case 2, or /mfa/enable), so one SSO round-trip covers the
  // whole setup -> confirm flow.
  const stepUpError = await resolveEnrollmentStepUp(
    c,
    auth,
    { currentPassword, ssoReauthGrantId },
    { keyPrefix: 'mfa:pwd', consume: false, rejectionStatus: MFA_PROOF_REJECTION_STATUS }
  );
  if (stepUpError) return stepUpError;

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
  // Store secret temporarily (not enabled yet until verified)
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'MFA setup unavailable. Please try again later.' }, 503);
  }
  await redis.setex(
    `mfa:setup:${auth.user.id}`,
    600, // 10 min expiry
    JSON.stringify({ secret })
  );

  return c.json({
    secret,
    otpAuthUrl,
    qrCodeDataUrl
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

    const transitionV1 = isAuthTransitionV1Request(c);
    if (!transitionV1 && authBrowserTransitionsEnforced()) {
      return authClientUpgradeRequiredResponse(c);
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

    // Resolve live policy for the client-selected method. Passkey remains on
    // its dedicated WebAuthn continuation; this route handles TOTP, SMS, and
    // recovery only.
    const livePolicy = await getEffectiveMfaPolicy({
      scope: mfaContext.scope,
      userId: user.id,
      orgId: mfaContext.orgId,
      partnerId: mfaContext.partnerId,
    });
    const effectiveMethod = method ?? pendingMfaMethod;

    let valid = false;
    let migratedMfaSecret: string | null = null;
    if (effectiveMethod === 'passkey') {
      return c.json({ error: 'Use passkey verification for this MFA session' }, 400);
    }

    const methodVerdict = evaluatePendingMfaMethod(
      pending,
      effectiveMethod,
      user,
      livePolicy.allowedMethods,
    );
    if (!methodVerdict.ok) {
      if (methodVerdict.terminal) await redis.del(`mfa:pending:${tempToken}`);
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'mfa_method_not_allowed',
        details: { method: effectiveMethod, phase: methodVerdict.reason },
      });
      return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
    }

    let capability: AuthIssuanceCapability | null = null;
    if (transitionV1) {
      try {
        capability = await beginAuthIssuance(requestAuthBinding(c));
        if (
          capability.transitionId !== pending.transitionId
          || capability.generation !== pending.browserGeneration
        ) {
          await cancelAuthIssuance(capability);
          return c.json({ error: 'Invalid or expired MFA session' }, 409);
        }
      } catch (error) {
        const response = authIssuanceAdmissionError(c, error);
        if (!response) throw error;
        return response;
      }
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
    try {
      if (effectiveMethod === 'recovery') {
        // The authoritative hash check and relative delete occur only inside the
        // guarded finalization below. A logout-pending transition can therefore
        // never burn a recovery code.
        valid = true;
      } else if (effectiveMethod === 'sms') {
        const phone = user.phoneNumber;
        if (!phone) {
          if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
          return c.json({ error: 'No phone number configured for SMS MFA' }, 400);
        }
        const twilio = getTwilioService();
        if (!twilio) {
          if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
          return c.json({ error: 'SMS service not configured' }, 501);
        }
        const result = await twilio.checkVerificationCode(phone, code);
        if (result.serviceError) {
          if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
          return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
        }
        valid = result.valid;
      } else {
        // TOTP verification
        const decrypted = decryptMfaSecretForMigration(user.mfaSecret);
        const decryptedMfaSecret = decrypted.plaintext;
        if (!decryptedMfaSecret) {
          if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
          return c.json({ error: 'Invalid MFA configuration' }, 400);
        }
        migratedMfaSecret = decrypted.migratedSecret;
        // consumeMFAToken: single-use per (user, step) so a live code can't be
        // replayed into a second login session. (security review #2)
        valid = await consumeMFAToken(decryptedMfaSecret, code, user.id);
      }
    } catch (error) {
      if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
      throw error;
    }

    if (!valid) {
      if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'mfa_invalid_code',
        details: { method: effectiveMethod }
      });
      return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
    }

    // #4067: this MFA step may be the continuation of a link-on-first-SSO-
    // login ceremony (/sso/link/confirm verified the password, this endpoint
    // verified the Breeze-held factor). Finalize the SSO link + SSO-style
    // mint instead of the password-login mint below —
    // finalizeSsoPendingLink re-validates the user/provider/epoch bindings
    // against live state and refuses on any drift.
    if (pending.ssoLinkTokenHash) {
      const linkCapability = capability ?? undefined;
      capability = null; // ownership transfers to the finalizer
      const outcome = await finalizeSsoPendingLink(c, pending.ssoLinkTokenHash, {
        breezeMfaVerified: true,
        expectedUserId: user.id,
        capability: linkCapability,
        ...(effectiveMethod === 'recovery' ? { recoveryCode: code } : {}),
      });
      if (!outcome.ok) {
        if (outcome.error === 'invalid_mfa_code') {
          void auditUserLoginFailure(c, {
            userId: user.id, email: user.email, name: user.name,
            reason: 'mfa_recovery_code_invalid', details: { method: 'recovery' },
          });
          return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
        }
        if (outcome.error === 'identity_in_use') {
          return c.json({ error: 'identity_in_use' }, 409);
        }
        if (outcome.error === 'completion_failed') {
          // Proofs were fine; the account can't complete (membership/mint).
          // NOT the expired view — a restart loops the user forever.
          return c.json({ error: 'completion_failed' }, 403);
        }
        // Distinct code: the FACTOR was correct — it's the link ceremony that
        // is dead (TTL, provider re-config, state drift). The connect page
        // maps this to its expired view; 'Invalid or expired MFA session'
        // here would strand the user retrying a code that can never work.
        return c.json({ error: 'sso_link_expired' }, 401);
      }
      await redis.del(`mfa:pending:${tempToken}`);
      installAuthorizedUserSessionCookies(c, outcome.session);
      c.header('Cache-Control', 'no-store');
      return c.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          mfaEnabled: true,
          avatarUrl: user.avatarUrl,
          isPlatformAdmin: user.isPlatformAdmin === true
        },
        tokens: { accessToken: outcome.accessToken, expiresInSeconds: outcome.expiresInSeconds },
        mfaRequired: false,
        requiresSetup: userRequiresSetup(user),
        redirectPath: outcome.redirectPath
      });
    }

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
    const identity: UserSessionIdentity = {
      userId: user.id,
      email: user.email,
      roleId: mfaRoleId,
      orgId: mfaOrgId,
      partnerId: mfaPartnerId,
      scope: mfaScope,
      mfa: true,
      // SR-001: bind to the mobile install id when present (MFA login path).
      mobileDeviceId: readMobileDeviceId(c) ?? undefined,
    };

    let tokens: ReturnType<typeof toPublicTokens>;
    let mfaFamilyId: string;
    let installSessionCookies: () => void;
    if (capability) {
      const guardedCapability = capability;
      let issued: AuthorizedUserSession;
      try {
        issued = await finishAuthIssuance(guardedCapability, async (tx) => {
          if (effectiveMethod === 'recovery') await consumeRecoveryCode(tx, user.id, code);
          const session = await issueUserSession(identity, {
            tx,
            capability: guardedCapability,
            expectedEpochs: { authEpoch: pending.authEpoch, mfaEpoch: pending.mfaEpoch },
          });
          await tx
            .update(users)
            .set({
              lastLoginAt: new Date(),
              ...(migratedMfaSecret ? { mfaSecret: migratedMfaSecret, updatedAt: new Date() } : {}),
            })
            .where(eq(users.id, user.id));
          return session;
        });
      } catch (error) {
        await cancelAuthIssuance(guardedCapability).catch(() => undefined);
        if (error instanceof RecoveryCodeInvalidError) {
          void auditUserLoginFailure(c, {
            userId: user.id, email: user.email, name: user.name,
            reason: 'mfa_recovery_code_invalid', details: { method: 'recovery' },
          });
          return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
        }
        const response = authIssuanceAdmissionError(c, error);
        if (!response) throw error;
        return response;
      }
      await bindIssuedUserSession(issued);
      tokens = toPublicTokens(issued);
      mfaFamilyId = issued.familyId;
      installSessionCookies = () => installAuthorizedUserSessionCookies(c, issued);
    } else {
      const issuer = effectiveMethod;
      if (effectiveMethod === 'recovery') {
        try {
          await runOutsideDbContext(() => withSystemDbAccessContext(() =>
            db.transaction((tx) => consumeRecoveryCode(tx, user.id, code))
          ));
        } catch (error) {
          if (!(error instanceof RecoveryCodeInvalidError)) throw error;
          void auditUserLoginFailure(c, {
            userId: user.id, email: user.email, name: user.name,
            reason: 'mfa_recovery_code_invalid', details: { method: 'recovery' },
          });
          return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
        }
      }
      recordAuthTransitionLegacyIssuer(issuer, authTransitionClientClass(c));
      const issued = await issueUserSessionLegacyDuringTransition(identity);
      await withSystemDbAccessContext(() =>
        db
          .update(users)
          .set({
            lastLoginAt: new Date(),
            ...(migratedMfaSecret ? { mfaSecret: migratedMfaSecret, updatedAt: new Date() } : {}),
          })
          .where(eq(users.id, user.id))
      );
      tokens = toPublicTokens(issued);
      mfaFamilyId = issued.familyId;
      installSessionCookies = () => installLegacyUserSessionCookiesDuringTransition(c, issued);
    }

    // Consume the pending bearer only after the guarded authority commits.
    await redis.del(`mfa:pending:${tempToken}`);

    if (effectiveMethod === 'recovery') {
      const stored = Array.isArray(user.mfaRecoveryCodes) ? user.mfaRecoveryCodes : [];
      writeAuthAudit(c, {
        orgId: undefined,
        action: 'auth.mfa.recovery_code.used',
        result: 'success',
        userId: user.id,
        email: user.email,
        details: { remainingApprox: Math.max(0, stored.length - 1) },
      });
    }

    auditLogin(c, { orgId: mfaOrgId ?? null, userId: user.id, email: user.email, name: user.name, mfa: true, scope: mfaScope, ip: getClientIP(c) });

    installSessionCookies();

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
      tokens,
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
  try {
    const parsed = JSON.parse(setupData);
    secret = parsed.secret;
    if (typeof secret !== 'string') throw new Error('Invalid setup data');
  } catch {
    return c.json({ error: 'Invalid MFA setup data' }, 500);
  }
  const policyError = await enforceTotpEnrollmentPolicy(c, auth);
  if (policyError) return policyError;
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
    return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
  }

  // Terminal factor write: NOW consume the grant (single-use). Re-checks the
  // binding against the LIVE epochs, so a factor change or session switch
  // between validate and consume invalidates it. A loss here (concurrent
  // consume of the same grant) fails CLOSED with the same 403 — the factor is
  // not written.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpConsumeError) return stepUpConsumeError;

  // #4018: terminal burn for the passwordless SSO road. This is the confirm
  // half of the /mfa/setup flow whose gate validated the grant non-consumingly,
  // so ONE enroll_first_factor grant installs exactly one factor.
  // `passwordAlreadyProven` because this branch never had a password gate of
  // its own — /mfa/setup holds it — and must stay unchanged for password
  // accounts.
  const enrollmentConsumeError = await resolveEnrollmentStepUp(
    c,
    auth,
    { ssoReauthGrantId: c.req.valid('json').ssoReauthGrantId },
    { keyPrefix: 'mfa:pwd', consume: true, passwordAlreadyProven: true, rejectionStatus: MFA_PROOF_REJECTION_STATUS }
  );
  if (enrollmentConsumeError) return enrollmentConsumeError;

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
      revokeReason: 'mfa-setup-confirm',
      recoveryCodes,
      recoveryCodeHashes,
      persistFactor: async (tx, hashes) => {
        const rows = await tx
          .update(users)
          .set({
            mfaSecret: encryptMfaSecret(secret),
            mfaEnabled: true,
            mfaMethod: 'totp',
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

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: setupOrgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp', mfaEpoch: result.mfaEpoch, teardownFailed: result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED }
  });

  await redis.del(`mfa:setup:${auth.user.id}`);

  return c.json({
    success: true,
    message: 'MFA enabled successfully',
    recoveryCodes: result.recoveryCodes,
    tokens: toPublicTokens(result.issued),
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
  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd', {
    rejectionStatus: MFA_PROOF_REJECTION_STATUS,
  });
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
      return rejectProof(c, 'Invalid verification code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
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
      return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
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
mfaRoutes.post('/mfa/enable', authMiddleware, zValidator('json', mfaEnableWithStepUpSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { code, currentPassword, ssoReauthGrantId, stepUpGrantId } = c.req.valid('json');

  // Re-verify identity before flipping mfaEnabled=true on the user row:
  // password, or (passwordless SSO accounts only, #4018) a fresh SSO re-auth
  // grant. Same two-phase idiom as the SR2-20 grant below — VALIDATE here,
  // CONSUME after the TOTP code proves out — so a mistyped code does not burn
  // the user's single-use grant and force another IdP round-trip.
  const enrollmentError = await resolveEnrollmentStepUp(
    c,
    auth,
    { currentPassword, ssoReauthGrantId },
    { keyPrefix: 'mfa:pwd', consume: false, rejectionStatus: MFA_PROOF_REJECTION_STATUS }
  );
  if (enrollmentError) return enrollmentError;

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
  try {
    const parsed = JSON.parse(setupData) as { secret?: unknown };
    if (typeof parsed.secret !== 'string') {
      throw new Error('Invalid setup data');
    }
    secret = parsed.secret;
  } catch {
    const message = 'Invalid MFA setup data';
    return c.json({ error: message, message }, 500);
  }
  const policyError = await enforceTotpEnrollmentPolicy(c, auth);
  if (policyError) return policyError;

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
    return rejectProof(c, 'Invalid MFA code', MFA_CODE_INVALID, MFA_PROOF_REJECTION_STATUS);
  }

  // Terminal factor write: NOW consume the grant (single-use). Re-checks the
  // binding against the LIVE epochs, so a factor change or session switch
  // between validate and consume invalidates it. A loss here (concurrent
  // consume of the same grant) fails CLOSED with the same 403 — the factor is
  // not written.
  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpConsumeError) return stepUpConsumeError;

  // #4018: same terminal burn for the passwordless SSO road — one
  // enroll_first_factor grant installs exactly one factor. `passwordAlreadyProven`
  // because the password road was already satisfied at the gate above.
  //
  // Deliberately omit `currentPassword` here (unlike the gate call above,
  // which needs it to pick a road). resolveEnrollmentStepUp's road-1
  // short-circuit (`if (input.currentPassword)`) runs BEFORE the
  // `passwordAlreadyProven` check, so passing it again would re-run
  // requireCurrentPasswordStepUp — a second argon2 verify and a second charge
  // against the 5-per-5-minutes step-up rate limit for every successful
  // enable, and a user on their 4th attempt would take a 429 here AFTER
  // consumeMFAToken already burned their TOTP time-step above.
  const enrollmentConsumeError = await resolveEnrollmentStepUp(
    c,
    auth,
    { ssoReauthGrantId },
    { keyPrefix: 'mfa:pwd', consume: true, passwordAlreadyProven: true, rejectionStatus: MFA_PROOF_REJECTION_STATUS }
  );
  if (enrollmentConsumeError) return enrollmentConsumeError;

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
      revokeReason: 'mfa-enable',
      recoveryCodes,
      recoveryCodeHashes,
      persistFactor: async (tx, hashes) => {
        const rows = await tx
          .update(users)
          .set({
            mfaSecret: encryptMfaSecret(secret),
            mfaEnabled: true,
            mfaMethod: 'totp',
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

  await redis.del(`mfa:setup:${auth.user.id}`);

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: setupOrgId ?? undefined,
    action: 'auth.mfa.setup',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'totp', mfaEpoch: result.mfaEpoch, teardownFailed: result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED }
  });

  return c.json({
    success: true,
    recoveryCodes: result.recoveryCodes,
    message: 'MFA enabled successfully',
    tokens: toPublicTokens(result.issued),
  });
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
  if (body.operation === 'agent_rollback' && !body.resource) {
    return c.json({ error: 'Rollback resource binding is required' }, 400);
  }
  if (body.operation !== 'agent_rollback' && body.resource) {
    return c.json({ error: 'Resource binding is only valid for agent rollback' }, 400);
  }

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
      // Same response as a wrong code below — a distinguishable rejection here
      // would tell an attacker which factor the account actually holds.
      return rejectProof(c, 'Invalid credentials', MFA_PROOF_INVALID, MFA_PROOF_REJECTION_STATUS);
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
    return rejectProof(c, 'Invalid credentials', MFA_PROOF_INVALID, MFA_PROOF_REJECTION_STATUS);
  }

  const epochs = await getUserEpochs(auth.user.id);
  if (!epochs || !auth.token?.sid) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const grantId = await mintStepUpGrant({
    userId: auth.user.id,
    operation: body.operation,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid: auth.token.sid,
    resourceDigest: body.operation === 'agent_rollback'
      ? rollbackResourceDigest(body.resource!)
      : '',
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

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'mfa:pwd', {
    rejectionStatus: MFA_PROOF_REJECTION_STATUS,
  });
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
