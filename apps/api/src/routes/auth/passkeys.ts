import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { userPasskeys, users } from '../../db/schema';
import { finalizeSsoPendingLink } from './ssoLinkCompletion';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import {
  getRedis,
  getUserEpochs,
  mfaLimiter,
  rateLimiter,
  beginAuthIssuance,
  finishAuthIssuance,
  cancelAuthIssuance,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  issueUserSession,
  bindIssuedUserSession,
  completeAdditionalMfaFactorEnrollment,
  completeInitialMfaEnrollment,
  completeMfaFactorRemoval,
  generateRecoveryCodes,
  type AuthIssuanceCapability,
  type AuthorizedUserSession,
  type UserSessionIdentity,
} from '../../services';
import {
  PasskeyChallengeError,
  authenticationInfoToPasskeyUpdateFields,
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  registrationInfoToPasskeyFields,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration
} from '../../services/passkeys';
import { carryForwardBinding, readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { passkeyRemovalResourceDigest } from '../../services/mfaStepUpGrant';
import { captureException } from '../../services/sentry';
import { enforceIpAllowlist, IP_NOT_ALLOWED_BODY, isBlocked } from '../../services/ipAllowlist';
import { TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { type Tx } from '../../services/authLifecycle';
import { ENABLE_2FA } from './schemas';
import {
  auditLogin,
  evaluatePendingMfa,
  enforceExistingFactorStepUp,
  getClientIP,
  mfaDisabledResponse,
  parsePendingMfa,
  type PendingMfaRecord,
  requireCurrentPasswordStepUp,
  resolveCurrentUserTokenContext,
  resolveEnrollmentStepUp,
  rejectProof,
  MFA_PROOF_INVALID,
  installAuthorizedUserSessionCookies,
  toPublicTokens,
  userRequiresSetup,
  writeAuthAudit,
  hashRecoveryCodes,
} from './helpers';
import { installAuthBindingReplacement, requestAuthBinding } from './binding';

const { db, withSystemDbAccessContext, runOutsideDbContext } = dbModule;

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

/**
 * POST-COMMIT session install for the factor writes that replace the caller's
 * session (#5038). The factor write is already committed and every OTHER
 * session is already dead by the time this runs, so a failure here must NOT be
 * turned into an error the user retries — a retried passkey registration
 * duplicates a credential, and a retried delete answers 404. Report it, step
 * over, and let the caller withhold the tokens it would otherwise return: the
 * refresh JTI was never bound, so the access token would die at its first
 * refresh anyway. Same rule /mfa/disable and /mfa/recovery-codes follow.
 *
 * Returns whether the replacement is safe to hand back.
 */
async function installReplacementSession(
  c: Context,
  issued: AuthorizedUserSession,
  userId: string,
  factorChange: string,
): Promise<boolean> {
  try {
    await bindIssuedUserSession(issued);
    installAuthorizedUserSessionCookies(c, issued);
    return true;
  } catch (error) {
    captureException(error, c, { factorChange });
    console.error('[auth] passkey factor write committed but the replacement session could not be installed', {
      userId,
      factorChange,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// WebAuthn assertion/attestation payloads are large nested objects validated
// structurally by @simplewebauthn; at this layer we only need a string `id` to
// look up the stored credential. Require it so a malformed body is rejected at
// validation (400) instead of falling through to a confusing "passkey not
// registered" (403). Output type stays `any` so it forwards to the WebAuthn
// library's typed verifiers unchanged.
const webAuthnCredentialSchema = z
  .any()
  .refine(
    (value): boolean => typeof value?.id === 'string' && value.id.length > 0,
    { message: 'credential.id is required' }
  );

const passkeyNameSchema = z.string().trim().min(1).max(255);
// #4018: BOTH enrollment proofs are optional HERE — resolveEnrollmentStepUp
// decides which road this account may take, and "neither supplied" must be its
// opaque 401 rather than a 400 from this schema, so the rejection never reveals
// whether the account has a password. `deletePasskeySchema` below is untouched:
// deleting a factor is not a first-factor enrollment and an
// enroll_first_factor grant must never authorize it.
const registerOptionsSchema = z.object({
  currentPassword: z.string().min(1).max(256).optional(),
  ssoReauthGrantId: z.string().uuid().optional(),
  name: passkeyNameSchema.optional(),
  // SR2-20: existing-factor step-up grant required when the account is
  // already MFA-protected (see enforceExistingFactorStepUp in ./helpers).
  stepUpGrantId: z.string().optional()
});
const registerVerifySchema = z.object({
  credential: webAuthnCredentialSchema,
  name: passkeyNameSchema.optional(),
  ssoReauthGrantId: z.string().uuid().optional(),
  stepUpGrantId: z.string().optional()
});
const passkeyMfaOptionsSchema = z.object({
  tempToken: z.string().min(1)
});
const passkeyMfaVerifySchema = z.object({
  tempToken: z.string().min(1),
  credential: webAuthnCredentialSchema
});
const renamePasskeySchema = z.object({
  name: passkeyNameSchema
});
const deletePasskeySchema = z.object({
  currentPassword: z.string().min(1).max(256),
  // Optional at validation so a stale client receives the stable security
  // boundary response (`existing_factor_step_up_required`) rather than a
  // generic schema error. The handler still fails closed when it is absent.
  stepUpGrantId: z.string().uuid().optional(),
});

class LastRequiredMfaFactorError extends Error {}

// A pending MFA session may use the passkey endpoints when passkey is either
// the account's primary method OR an available alternate factor. Both /options
// and /verify still independently re-verify that a matching, non-disabled
// credential is owned by the user and that the WebAuthn assertion checks out,
// so this gate only decides whether the passkey path is OFFERED — it never
// substitutes for credential/assertion verification.
function pendingAllowsPasskey(pending: PendingMfaRecord): boolean {
  return pending.allowedMethods.passkey;
}

type PasskeyRow = typeof userPasskeys.$inferSelect;

export const passkeyRoutes = new Hono();

passkeyRoutes.get('/passkeys', authMiddleware, async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const rows = await listActivePasskeys(auth.user.id);
  return c.json({ passkeys: rows.map(toPublicPasskey) });
});

/**
 * #4470: the AUTHENTICATED passkey factor-management routes
 * (`/passkeys/register/options`, `/passkeys/register/verify`,
 * `DELETE /passkeys/:id`) answer a rejected proof with 400, exactly like
 * `./mfa.ts`. `ProfilePage.handleAddPasskey` / `handleDeletePasskey` call all
 * three through `fetchWithAuth` with no opt-out and no status branch, so while
 * these answered 401 a mistyped step-up password — or a stale registration
 * challenge — was handed to the generic refresh-and-replay path and could sign
 * the user out mid-enrollment. Same bug, same fix.
 *
 * The LOGIN-time passkey routes further down (`/mfa/passkey/options`,
 * `/mfa/passkey/verify`) deliberately keep their 401s: they are pre-session,
 * scoped to a `tempToken` rather than a bearer, and are reached with a plain
 * `fetch` that has no refresh path to mislead.
 */
const PASSKEY_PROOF_REJECTION_STATUS = 400;

passkeyRoutes.post('/passkeys/register/options', authMiddleware, zValidator('json', registerOptionsSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword, ssoReauthGrantId, stepUpGrantId } = c.req.valid('json');

  // Password, or (passwordless SSO accounts only, #4018) a grant from a fresh
  // forced re-authentication at the IdP. Non-consuming — this is the gate; the
  // SAME grant is consumed at /passkeys/register/verify below.
  const enrollmentError = await resolveEnrollmentStepUp(
    c,
    auth,
    { currentPassword, ssoReauthGrantId },
    { keyPrefix: 'passkey:pwd', consume: false, rejectionStatus: PASSKEY_PROOF_REJECTION_STATUS }
  );
  if (enrollmentError) return enrollmentError;

  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof. Non-consuming here — the SAME
  // grant is consumed at /passkeys/register/verify below.
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: false });
  if (stepUpError) return stepUpError;

  const existingPasskeys = await listActivePasskeys(auth.user.id);
  const options = await generatePasskeyRegistrationOptions({
    user: auth.user,
    epochs: { authEpoch: auth.token?.aep as number, mfaEpoch: auth.token?.mep as number },
    existingPasskeys: existingPasskeys.map(toStoredCredential)
  });

  return c.json({ options });
});

passkeyRoutes.post('/passkeys/register/verify', authMiddleware, zValidator('json', registerVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { credential, name, ssoReauthGrantId, stepUpGrantId } = c.req.valid('json');

  let verification;
  try {
    verification = await verifyPasskeyRegistration({
      userId: auth.user.id,
      epochs: { authEpoch: auth.token?.aep as number, mfaEpoch: auth.token?.mep as number },
      response: credential
    });
  } catch (err) {
    if (err instanceof PasskeyChallengeError) {
      // #4470: the registration challenge could not be redeemed — usually
      // because it is missing or expired. Whatever the cause, it is not a dead
      // bearer, and the challenge is single-use, so refresh-and-replaying this
      // body could only ever fail again. On the settings page that 401 logged
      // the user out for it.
      //
      // `PasskeyChallengeError` also covers "Redis unavailable" and a corrupt
      // record, which are infra failures rather than rejected proofs and would
      // be better served by a 503. That conflation predates this change (they
      // shared the old 401 too) and is left for a follow-up — 400 at least
      // keeps the user signed in where 401 did not.
      return rejectProof(c, err.message, MFA_PROOF_INVALID, PASSKEY_PROOF_REJECTION_STATUS);
    }
    throw err;
  }

  if (!verification.verified) {
    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.mfa.passkey.register.failed',
      result: 'failure',
      reason: 'invalid_passkey_registration',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: 'passkey' }
    });
    return rejectProof(c, 'Passkey registration failed', MFA_PROOF_INVALID, PASSKEY_PROOF_REJECTION_STATUS);
  }

  const fields = registrationInfoToPasskeyFields(verification, credential);

  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor proof. Single-use consume — this is the
  // terminal factor write.
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, { consume: true });
  if (stepUpError) return stepUpError;

  // #4018: terminal burn for the passwordless SSO road — one
  // enroll_first_factor grant registers exactly one passkey. `passwordAlreadyProven`
  // because this endpoint carries no password field at all: the password road
  // was satisfied at /passkeys/register/options, and re-demanding it here would
  // break every existing password-account registration.
  const enrollmentConsumeError = await resolveEnrollmentStepUp(
    c,
    auth,
    { ssoReauthGrantId },
    { keyPrefix: 'passkey:pwd', consume: true, passwordAlreadyProven: true, rejectionStatus: PASSKEY_PROOF_REJECTION_STATUS }
  );
  if (enrollmentConsumeError) return enrollmentConsumeError;

  const [enrollmentState] = await db
    .select({
      mfaEnabled: users.mfaEnabled,
      mfaSecret: users.mfaSecret,
      mfaMethod: users.mfaMethod,
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  if (!enrollmentState) return c.json({ error: 'User not found' }, 404);

  let inserted: PasskeyRow | undefined;
  const persistPasskey = async (tx: Tx) => {
    const [row] = await tx
      .insert(userPasskeys)
      .values({
        userId: auth.user.id,
        credentialId: fields.credentialId,
        publicKey: fields.publicKey,
        counter: fields.counter,
        deviceType: fields.deviceType,
        backedUp: fields.backedUp,
        transports: fields.transports,
        name: name ?? 'Passkey',
        aaguid: fields.aaguid,
        updatedAt: new Date()
      })
      .returning();

    if (!row) {
      throw new Error('Passkey insert returned no row');
    }
    inserted = row;
    return row;
  };

  let mfaEpoch: number;
  let teardownFailed: boolean;
  let sessionInstalled = true;
  let replacement: { recoveryCodes: string[] | null; issued: AuthorizedUserSession | null } | null = null;
  if (!enrollmentState.mfaEnabled) {
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
        revokeReason: 'passkey-register',
        recoveryCodes,
        recoveryCodeHashes,
        persistFactor: async (tx, hashes) => {
          const enabled = await tx
            .update(users)
            .set({
              mfaEnabled: true,
              mfaMethod: 'passkey',
              mfaRecoveryCodes: [...hashes],
              updatedAt: new Date(),
            })
            .where(and(eq(users.id, auth.user.id), eq(users.mfaEnabled, false)))
            .returning({ id: users.id });
          if (enabled.length !== 1) throw new Error('MFA enrollment state changed');
          return persistPasskey(tx);
        },
      });
    } catch (error) {
      await cancelAuthIssuance(capability).catch(() => undefined);
      const response = authIssuanceAdmissionError(c, error);
      if (!response) throw error;
      return response;
    }
    sessionInstalled = await installReplacementSession(c, result.issued, auth.user.id, 'passkey_register');
    mfaEpoch = result.mfaEpoch;
    teardownFailed = result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED;
    // The one-time recovery codes are reported even when the session install
    // failed — they are already the account's only valid set, and swallowing
    // them would lock the user out of their own new factor.
    replacement = { recoveryCodes: result.recoveryCodes, issued: sessionInstalled ? result.issued : null };
  } else {
    // #5038: a SECONDARY factor addition still advances mfa_epoch and revokes
    // every refresh family — no other live session may keep an assurance minted
    // before the account's factor set changed (SR2-07) — but it must not evict
    // the ACTOR. The old path did exactly that: the caller's access token went
    // stale on its own bump and the refresh cookie it would retry with belonged
    // to a family revoked in the same transaction, so the web client
    // hard-redirected to /login?reason=session-expired the moment the user
    // added a second passkey. Same road /mfa/disable took in #4934/#5008.
    // The account's existing recovery-code set is untouched: adding a factor
    // reveals no new one-time secret, so none is rotated.
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
      result = await completeAdditionalMfaFactorEnrollment({
        userId: auth.user.id,
        identity: {
          userId: auth.user.id,
          email: auth.user.email,
          roleId: auth.token?.roleId ?? null,
          orgId: auth.orgId ?? null,
          partnerId: auth.partnerId ?? null,
          scope: auth.scope,
          // Carry the caller's OWN assurance forward, never elevate it: this
          // endpoint's step-up gate proves an existing factor, not that the
          // session itself was MFA-assured.
          mfa: auth.token?.mfa === true,
          // SR-001: a RE-MINT takes its device binding from the previously
          // signed `mdid` claim, never the forgeable request header.
          mobileDeviceId: carryForwardBinding(auth.token ?? {}),
        },
        capability,
        expectedAuthEpoch: auth.token?.aep as number,
        expectedMfaEpoch: auth.token?.mep as number,
        revokeReason: 'passkey-register',
        persistFactor: async (tx) => {
          await persistPasskey(tx);
          const hasExistingFactor = Boolean(enrollmentState.mfaSecret) || enrollmentState.mfaMethod === 'sms';

          const rows = await tx
            .update(users)
            .set({
              mfaEnabled: true,
              ...(hasExistingFactor ? {} : { mfaMethod: 'passkey' }),
              updatedAt: new Date()
            })
            .where(eq(users.id, auth.user.id))
            .returning({ id: users.id });
          if (rows.length !== 1) throw new Error('Passkey registration user disappeared');
          return undefined;
        },
      });
    } catch (error) {
      await cancelAuthIssuance(capability).catch(() => undefined);
      const response = authIssuanceAdmissionError(c, error);
      if (!response) throw error;
      return response;
    }

    sessionInstalled = await installReplacementSession(c, result.issued, auth.user.id, 'passkey_register');
    mfaEpoch = result.mfaEpoch;
    teardownFailed = result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED;
    // No recovery codes: the account already holds its own set.
    replacement = { recoveryCodes: null, issued: sessionInstalled ? result.issued : null };
  }

  if (!inserted) {
    throw new Error('Passkey insert returned no row');
  }

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.passkey.register',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: {
      method: 'passkey',
      credentialId: fields.credentialId,
      mfaEpoch,
      teardownFailed,
      sessionInstalled
    }
  });

  if (replacement) c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    passkey: toPublicPasskey(inserted),
    // Recovery codes appear only on the INITIAL enrollment that minted them.
    ...(replacement?.recoveryCodes ? { recoveryCodes: replacement.recoveryCodes } : {}),
    // Withheld when the post-commit install failed: the refresh JTI was never
    // bound, so the access token would die at its first refresh.
    ...(replacement?.issued ? { tokens: toPublicTokens(replacement.issued) } : {}),
  });
});

// SR2-20: authenticated passkey step-up challenge. Mirrors /mfa/passkey/options
// (the login-time challenge issuer below), but keyed on the LOGGED-IN user
// rather than a pre-auth login tempToken — this lets a passkey-only user
// prove their existing factor to mint a step-up grant (POST /auth/mfa/step-up)
// without a TOTP/SMS fallback, avoiding a lockout.
passkeyRoutes.post('/mfa/step-up/options', authMiddleware, async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const passkeys = await withSystemDbAccessContext(() => listActivePasskeys(auth.user.id));
  if (passkeys.length === 0) {
    return c.json({ error: 'No passkeys are registered for this account' }, 400);
  }

  const options = await generatePasskeyAuthenticationOptions({
    userId: auth.user.id,
    passkeys: passkeys.map(toStoredCredential)
  });

  c.header('Cache-Control', 'no-store');
  return c.json({ options });
});

/**
 * Verify a WebAuthn assertion as proof of an existing passkey factor for the
 * SR2-20 step-up flow. Loads the caller-owned passkey, verifies against the
 * stored authentication challenge (from POST /auth/mfa/step-up/options
 * above), persists the new signature counter (clone detection), and returns
 * whether it verified. Reused by mfa.ts's POST /auth/mfa/step-up passkey
 * branch — keeps all WebAuthn machinery inside this module. Never throws on
 * a challenge/ownership problem (returns false); other errors propagate.
 */
export async function verifyStepUpPasskeyAssertion(userId: string, credential: { id?: string }): Promise<boolean> {
  const [passkey] = await withSystemDbAccessContext(() =>
    db
      .select()
      .from(userPasskeys)
      .where(eq(userPasskeys.credentialId, credential?.id ?? ''))
      .limit(1)
  );
  if (!passkey || passkey.userId !== userId || passkey.disabledAt) {
    return false;
  }

  let verification;
  try {
    verification = await verifyPasskeyAuthentication({
      userId,
      response: credential as never,
      passkey: toStoredCredential(passkey)
    });
  } catch (err) {
    if (err instanceof PasskeyChallengeError) return false;
    throw err;
  }
  if (!verification.verified) return false;

  const updateFields = authenticationInfoToPasskeyUpdateFields(verification);
  await withSystemDbAccessContext(() =>
    db
      .update(userPasskeys)
      .set({ counter: updateFields.counter, lastUsedAt: updateFields.lastUsedAt, updatedAt: new Date() })
      .where(eq(userPasskeys.id, passkey.id))
  );
  return true;
}

passkeyRoutes.post('/mfa/passkey/options', zValidator('json', passkeyMfaOptionsSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const { tempToken } = c.req.valid('json');
  const pending = await readPendingPasskeyMfa(tempToken);
  if (!pending) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  if (!pendingAllowsPasskey(pending)) {
    return c.json({ error: 'Invalid MFA code' }, 401);
  }
  // Throttle challenge issuance so it can't be hammered, but on a SEPARATE
  // bucket from /verify. A legitimate retry issues one /options + one /verify;
  // sharing the bucket would let challenge issuance consume the verify
  // brute-force budget and 429 a user after ~2 attempts. Keep this bucket
  // generous (issuing a challenge verifies no secret).
  const rateCheck = await rateLimiter(
    getRedis(),
    `mfa:passkey-options:${pending.userId}`,
    mfaLimiter.limit * 4,
    mfaLimiter.windowSeconds
  );
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many MFA attempts' }, 429);
  }

  const [user] = await withSystemDbAccessContext(() =>
    db.select().from(users).where(eq(users.id, pending.userId)).limit(1)
  );
  if (!user) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  const liveEpochs = await getUserEpochs(user.id);
  const pendingVerdict = liveEpochs
    ? evaluatePendingMfa(pending, {
        status: user.status,
        authEpoch: liveEpochs.authEpoch,
        mfaEpoch: liveEpochs.mfaEpoch,
      })
    : ({ ok: false, reason: 'epoch_mismatch' } as const);
  if (!pendingVerdict.ok) {
    await getRedis()?.del(`mfa:pending:${tempToken}`);
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }

  const context = await resolveCurrentUserTokenContext(user.id);
  const livePolicy = await getEffectiveMfaPolicy({
    scope: context.scope,
    userId: user.id,
    orgId: context.orgId,
    partnerId: context.partnerId,
  });
  if (!livePolicy.allowedMethods.passkey) {
    await getRedis()?.del(`mfa:pending:${tempToken}`);
    return c.json({ error: 'Invalid MFA code' }, 401);
  }

  const passkeys = await withSystemDbAccessContext(() => listActivePasskeys(pending.userId));
  if (passkeys.length === 0) {
    return c.json({ error: 'No passkeys are registered for this account' }, 400);
  }

  const options = await generatePasskeyAuthenticationOptions({
    userId: pending.userId,
    passkeys: passkeys.map(toStoredCredential)
  });

  return c.json({ options });
});

passkeyRoutes.post('/mfa/passkey/verify', zValidator('json', passkeyMfaVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  }

  const { tempToken, credential } = c.req.valid('json');
  const pending = await readPendingPasskeyMfa(tempToken);
  if (!pending) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  if (!pendingAllowsPasskey(pending)) {
    return c.json({ error: 'Invalid MFA code' }, 401);
  }
  // Rate limit assertion attempts, mirroring the TOTP path in mfa.ts.
  const rateCheck = await rateLimiter(redis, `mfa:${pending.userId}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many MFA attempts' }, 429);
  }

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
  // SR2-06: re-check the live epoch/status before minting. A factor change
  // (mfa_epoch) or account-wide security event (auth_epoch) during the
  // 5-minute MFA window must invalidate this in-flight session.
  const liveEpochs = await getUserEpochs(user.id);
  const verdict = liveEpochs
    ? evaluatePendingMfa(pending, { status: user.status, authEpoch: liveEpochs.authEpoch, mfaEpoch: liveEpochs.mfaEpoch })
    : ({ ok: false, reason: 'epoch_mismatch' } as const);
  if (!verdict.ok) {
    await redis.del(`mfa:pending:${tempToken}`);
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }

  const [passkey] = await withSystemDbAccessContext(() =>
    db
      .select()
      .from(userPasskeys)
      .where(eq(userPasskeys.credentialId, credential?.id))
      .limit(1)
  );

  if (!passkey || passkey.userId !== pending.userId || passkey.disabledAt) {
    return c.json({ error: 'Passkey is not registered for this account' }, 403);
  }

  let capability: AuthIssuanceCapability | null = null;
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

  let verification;
  try {
    verification = await verifyPasskeyAuthentication({
      userId: pending.userId,
      response: credential,
      passkey: toStoredCredential(passkey)
    });
  } catch (err) {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
    if (err instanceof PasskeyChallengeError) {
      return c.json({ error: err.message }, 401);
    }
    throw err;
  }

  if (!verification.verified) {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
    return c.json({ error: 'Passkey verification failed' }, 401);
  }

  let updateFields: ReturnType<typeof authenticationInfoToPasskeyUpdateFields>;
  try {
    updateFields = authenticationInfoToPasskeyUpdateFields(verification);
  } catch (error) {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
    throw error;
  }
  let context;
  try {
    context = await resolveCurrentUserTokenContext(user.id);
    let ipDecision;
    try {
      ipDecision = await enforceIpAllowlist(c, {
        partnerId: context.partnerId,
        isPlatformAdmin: user.isPlatformAdmin === true,
        actorId: user.id,
        actorEmail: user.email,
      });
    } catch (error) {
      if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
      console.error('[auth] IP allowlist check failed during passkey MFA completion:', error);
      captureException(error, c);
      return c.json({ code: 'ip_check_failed', error: 'Access temporarily unavailable' }, 503);
    }
    if (isBlocked(ipDecision)) {
      if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
      return c.json(IP_NOT_ALLOWED_BODY, 403);
    }
    const livePolicy = await getEffectiveMfaPolicy({
      scope: context.scope,
      userId: user.id,
      orgId: context.orgId,
      partnerId: context.partnerId,
    });
    if (!livePolicy.allowedMethods.passkey) {
      if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
      await redis.del(`mfa:pending:${tempToken}`);
      return c.json({ error: 'Invalid MFA code' }, 401);
    }
  } catch (error) {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
    throw error;
  }
  if (pending.ssoLinkTokenHash) {
    // Preserve mainline's link-on-first-login semantics while the normal
    // password-login path below keeps passkey effects inside its guarded
    // issuance transaction.
    try {
      await withSystemDbAccessContext(() =>
        db
          .update(userPasskeys)
          .set({
            counter: updateFields.counter,
            deviceType: updateFields.deviceType,
            backedUp: updateFields.backedUp,
            lastUsedAt: updateFields.lastUsedAt,
            updatedAt: new Date()
          })
          .where(eq(userPasskeys.id, passkey.id))
      );
    } catch (error) {
      if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
      throw error;
    }
    const linkCapability = capability ?? undefined;
    capability = null; // ownership transfers to the finalizer
    const outcome = await finalizeSsoPendingLink(c, pending.ssoLinkTokenHash, {
      breezeMfaVerified: true,
      expectedUserId: user.id,
      capability: linkCapability,
    });
    if (!outcome.ok) {
      if (outcome.error === 'identity_in_use') {
        return c.json({ error: 'identity_in_use' }, 409);
      }
      if (outcome.error === 'completion_failed') {
        return c.json({ error: 'completion_failed' }, 403);
      }
      // Distinct code: the factor was correct — the link ceremony is dead.
      // The connect page maps this to its expired view (see mfa.ts sibling).
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
        mfaEnabled: true
      },
      tokens: { accessToken: outcome.accessToken, expiresInSeconds: outcome.expiresInSeconds },
      mfaRequired: false,
      requiresSetup: userRequiresSetup(user),
      redirectPath: outcome.redirectPath
    });
  }

  const identity: UserSessionIdentity = {
    userId: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: true,
    mobileDeviceId: readMobileDeviceId(c) ?? undefined,
  };

  let tokens: ReturnType<typeof toPublicTokens>;
  let installSessionCookies: () => void;
  const guardedCapability = capability;
  let issued: AuthorizedUserSession;
  try {
    issued = await finishAuthIssuance(guardedCapability, async (tx) => {
        const session = await issueUserSession(identity, {
          tx,
          capability: guardedCapability,
          expectedEpochs: { authEpoch: pending.authEpoch, mfaEpoch: pending.mfaEpoch },
        });
        await tx
          .update(userPasskeys)
          .set({
            counter: updateFields.counter,
            deviceType: updateFields.deviceType,
            backedUp: updateFields.backedUp,
            lastUsedAt: updateFields.lastUsedAt,
            updatedAt: new Date(),
          })
          .where(eq(userPasskeys.id, passkey.id));
        await tx
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, user.id));
        return session;
    });
  } catch (error) {
    await cancelAuthIssuance(guardedCapability).catch(() => undefined);
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }
  await bindIssuedUserSession(issued);
  tokens = toPublicTokens(issued);
  installSessionCookies = () => installAuthorizedUserSessionCookies(c, issued);

  // Single-use only after session authority commits.
  await redis.del(`mfa:pending:${tempToken}`);

  auditLogin(c, {
    orgId: context.orgId ?? null,
    userId: user.id,
    email: user.email,
    name: user.name,
    mfa: true,
    scope: context.scope,
    ip: getClientIP(c)
  });

  installSessionCookies();

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: true
    },
    tokens,
    mfaRequired: false,
    requiresSetup: userRequiresSetup(user)
  });
});

passkeyRoutes.patch('/passkeys/:id', authMiddleware, zValidator('json', renamePasskeySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const id = c.req.param('id');
  const { name } = c.req.valid('json');

  const [passkey] = await findOwnedPasskey(id, auth.user.id);
  if (!passkey) {
    return c.json({ error: 'Passkey not found' }, 404);
  }

  const [updated] = await db
    .update(userPasskeys)
    .set({ name, updatedAt: new Date() })
    .where(eq(userPasskeys.id, id))
    .returning();

  return c.json({ success: true, passkey: toPublicPasskey(updated ?? passkey) });
});

passkeyRoutes.delete('/passkeys/:id', authMiddleware, zValidator('json', deletePasskeySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const id = c.req.param('id');
  const { currentPassword, stepUpGrantId } = c.req.valid('json');

  if (auth.token?.mfa !== true) {
    return c.json({ error: 'MFA verification is required to delete a passkey' }, 403);
  }

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'passkey:pwd', {
    rejectionStatus: PASSKEY_PROOF_REJECTION_STATUS,
  });
  if (passwordError) return passwordError;

  const resourceDigest = passkeyRemovalResourceDigest(id);
  const stepUpError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, {
    consume: false,
    operation: 'delete_passkey',
    resourceDigest,
  });
  if (stepUpError) return stepUpError;

  const [passkey] = await findOwnedPasskey(id, auth.user.id);
  if (!passkey) {
    return c.json({ error: 'Passkey not found' }, 404);
  }

  const factorState = await getMfaFactorState(auth);
  const remainingFactorCount =
    (factorState.allowedMethods.passkey ? Math.max(0, factorState.passkeyCount - 1) : 0)
    + (factorState.allowedMethods.totp && factorState.hasTotp ? 1 : 0)
    + (factorState.allowedMethods.sms && factorState.hasSms ? 1 : 0);

  if (factorState.mfaRequired && remainingFactorCount === 0) {
    return c.json({ error: 'Cannot remove the last MFA factor while your role or organization requires MFA' }, 403);
  }

  // #5038: removing a factor advances mfa_epoch and revokes every refresh
  // family so no OTHER live session survives the account's factor set changing
  // (SR2-07) — but the caller must not be evicted by its own request. The old
  // path bumped the epoch without re-issuing, so deleting a passkey bounced the
  // user to /login?reason=session-expired. Same primitive #4934/#5008 gave
  // /mfa/disable: every other session dies, the actor's is replaced in the same
  // response.
  let capability: AuthIssuanceCapability;
  try {
    capability = await beginAuthIssuance(requestAuthBinding(c));
  } catch (error) {
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }

  const stepUpConsumeError = await enforceExistingFactorStepUp(c, auth, stepUpGrantId, {
    consume: true,
    operation: 'delete_passkey',
    resourceDigest,
  });
  if (stepUpConsumeError) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    return stepUpConsumeError;
  }

  let result;
  try {
    result = await completeMfaFactorRemoval({
      userId: auth.user.id,
      identity: {
        userId: auth.user.id,
        email: auth.user.email,
        roleId: auth.token?.roleId ?? null,
        orgId: auth.orgId ?? null,
        partnerId: auth.partnerId ?? null,
        scope: auth.scope,
        mfa: auth.token?.mfa === true,
        mobileDeviceId: carryForwardBinding(auth.token ?? {}),
      },
      capability,
      expectedAuthEpoch: auth.token?.aep as number,
      expectedMfaEpoch: auth.token?.mep as number,
      revokeReason: 'passkey-delete',
      persistFactor: async (tx) => {
        // Recompute under the same user-row lock and epoch predicate as the
        // removal. Two concurrent deletes cannot both rely on the same stale
        // count and remove the final policy-required factors.
        const [live] = await tx
          .select({
            passkeyCount: sql<number>`(
              SELECT COUNT(*)::int FROM user_passkeys
              WHERE user_id = ${auth.user.id} AND disabled_at IS NULL
            )`,
            hasTotp: sql<boolean>`${users.mfaSecret} IS NOT NULL`,
            hasSms: sql<boolean>`${users.mfaMethod} = 'sms' AND ${users.phoneVerified} = true`,
            currentMfaMethod: users.mfaMethod,
          })
          .from(users)
          .where(eq(users.id, auth.user.id))
          .limit(1);

        if (!live) throw new Error('Passkey owner disappeared');
        const allowedPasskeys = factorState.allowedMethods.passkey ? Number(live.passkeyCount) : 0;
        const allowedTotp = factorState.allowedMethods.totp && live.hasTotp ? 1 : 0;
        const allowedSms = factorState.allowedMethods.sms && live.hasSms ? 1 : 0;
        if (factorState.mfaRequired && Math.max(0, allowedPasskeys - 1) + allowedTotp + allowedSms === 0) {
          throw new LastRequiredMfaFactorError();
        }

        const deleted = await tx
          .delete(userPasskeys)
          .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, auth.user.id), isNull(userPasskeys.disabledAt)))
          .returning({ id: userPasskeys.id });
        if (deleted.length !== 1) throw new AuthIssuanceConflictError();

        const remainingPasskeys = Math.max(0, Number(live.passkeyCount) - 1);
        const remainingAllowedFactorCount = remainingPasskeys + allowedTotp + allowedSms;
        const currentMethodRemainsUsable =
          (live.currentMfaMethod === 'passkey' && remainingPasskeys > 0)
          || (live.currentMfaMethod === 'totp' && allowedTotp > 0)
          || (live.currentMfaMethod === 'sms' && allowedSms > 0);
        const nextMethod = currentMethodRemainsUsable
          ? live.currentMfaMethod
          : remainingPasskeys > 0
            ? 'passkey'
            : allowedTotp > 0
              ? 'totp'
              : allowedSms > 0
                ? 'sms'
                : null;
        const updated = await tx
          .update(users)
          .set({
            mfaEnabled: remainingAllowedFactorCount > 0,
            mfaMethod: remainingAllowedFactorCount > 0 ? nextMethod : null,
            // A password-only account must not retain a latent login factor.
            // Enrollment/rotation always replaces the complete code set, but
            // clearing here makes that invariant explicit at the downgrade.
            ...(remainingAllowedFactorCount === 0 ? { mfaRecoveryCodes: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, auth.user.id))
          .returning({ id: users.id });
        if (updated.length !== 1) throw new Error('Passkey owner disappeared');
        return undefined;
      },
    });
  } catch (error) {
    await cancelAuthIssuance(capability).catch(() => undefined);
    if (error instanceof LastRequiredMfaFactorError) {
      return c.json({ error: 'Cannot remove the last MFA factor while your role or organization requires MFA' }, 403);
    }
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }

  const sessionInstalled = await installReplacementSession(c, result.issued, auth.user.id, 'passkey_delete');

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.passkey.delete',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: {
      method: 'passkey',
      passkeyId: id,
      mfaEpoch: result.mfaEpoch,
      teardownFailed: result.cleanup.remoteSessionsTerminated === TEARDOWN_FAILED,
      sessionInstalled,
    }
  });

  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    ...(sessionInstalled ? { tokens: toPublicTokens(result.issued) } : {}),
  });
});

async function readPendingPasskeyMfa(tempToken: string): Promise<PendingMfaRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(`mfa:pending:${tempToken}`);
  if (!raw) return null;
  return parsePendingMfa(raw);
}

async function listActivePasskeys(userId: string): Promise<PasskeyRow[]> {
  return db
    .select()
    .from(userPasskeys)
    .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.disabledAt)))
    .limit(100);
}

function findOwnedPasskey(id: string, userId: string): Promise<PasskeyRow[]> {
  return db
    .select()
    .from(userPasskeys)
    .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId), isNull(userPasskeys.disabledAt)))
    .limit(1);
}

async function getMfaFactorState(auth: AuthContext): Promise<{
  passkeyCount: number;
  hasTotp: boolean;
  hasSms: boolean;
  currentMfaMethod: 'totp' | 'sms' | 'passkey' | null;
  mfaRequired: boolean;
  allowedMethods: { totp: boolean; sms: boolean; passkey: boolean };
}> {
  // I3/SR2-05: mfaRequired now comes from the resolver so a partner-set
  // requireMfa (partner-inherited, invisible to the old org-only EXISTS
  // below) blocks last-factor removal too, matching enrollment/login/disable.
  const policy = await getEffectiveMfaPolicy({
    scope: auth.scope,
    userId: auth.user.id,
    orgId: auth.orgId ?? null,
    partnerId: auth.partnerId ?? null,
  }, { failClosed: true, failClosedMethods: true });

  // This runs inside the DELETE handler's request (user-scoped) context, where
  // a bare `withSystemDbAccessContext` would be a no-op. Escape the active
  // context first so the factor-count read is not affected by user-scoped RLS
  // edge cases.
  const [state] = await runOutsideDbContext(() => withSystemDbAccessContext(async () =>
    db
      .select({
        passkeyCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM user_passkeys
          WHERE user_id = ${auth.user.id}
            AND disabled_at IS NULL
        )`,
        hasTotp: sql<boolean>`${users.mfaSecret} IS NOT NULL`,
        hasSms: sql<boolean>`${users.mfaMethod} = 'sms' AND ${users.phoneVerified} = true`,
        currentMfaMethod: users.mfaMethod
      })
      .from(users)
      .where(eq(users.id, auth.user.id))
      .limit(1)
  ));

  return {
    passkeyCount: Number(state?.passkeyCount ?? 0),
    hasTotp: Boolean(state?.hasTotp),
    hasSms: Boolean(state?.hasSms),
    currentMfaMethod: state?.currentMfaMethod ?? null,
    mfaRequired: policy.required,
    allowedMethods: policy.allowedMethods,
  };
}

function toStoredCredential(passkey: Pick<PasskeyRow, 'credentialId' | 'publicKey' | 'counter' | 'transports'>) {
  return {
    credentialId: passkey.credentialId,
    publicKey: passkey.publicKey,
    counter: passkey.counter,
    transports: passkey.transports
  };
}

function toPublicPasskey(passkey: Pick<PasskeyRow, 'id'> & Partial<PasskeyRow>) {
  return {
    id: passkey.id,
    name: passkey.name ?? 'Passkey',
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
    transports: passkey.transports ?? [],
    lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    createdAt: passkey.createdAt?.toISOString() ?? null
  };
}
