import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { userPasskeys, users } from '../../db/schema';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import {
  consumeMFAToken,
  getRedis,
  issueVerifiedPendingMfaSession,
  mfaLimiter,
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  rateLimiter,
  readPendingMfa,
  withAuthLifecycleSystemTransaction,
  type PendingMfaSessionV2,
} from '../../services';
import { lockMfaAssuranceState } from '../../services/mfaAssuranceLocks';
import { resolveEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { getTwilioService } from '../../services/twilio';
import {
  PasskeyChallengeError,
  authenticationInfoToPasskeyUpdateFields,
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  registrationInfoToPasskeyFields,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration
} from '../../services/passkeys';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { decryptMfaTotpSecret } from '../../services/mfaSecretCrypto';
import {
  cleanupMfaAssuranceUsers,
  MfaAssuranceMutationStaleError,
  runLockedMfaMutation,
} from '../../services/mfaAssuranceMutation';
import {
  ENABLE_2FA,
  mfaStepUpOptionsSchema,
  mfaStepUpVerifySchema,
  passkeyRegisterOptionsSchema,
  passkeyRegisterVerifySchema,
  webAuthnCredentialSchema,
} from './schemas';
import {
  auditLogin,
  consumeMfaStepUpGrant,
  getClientIP,
  hashMfaStepUpGrant,
  issueMfaStepUpGrant,
  MFA_STEP_UP_GRANT_TTL_SECONDS,
  MfaStepUpGrantInvalidError,
  MfaStepUpGrantUnavailableError,
  mfaDisabledResponse,
  readMfaStepUpGrant,
  requireCurrentPasswordStepUp,
  setRefreshTokenCookie,
  toPublicTokens,
  userRequiresSetup,
  writeAuthAudit
} from './helpers';
import type {
  MfaStepUpGrantExpectedBinding,
  MfaStepUpGrantRecord,
  MfaStepUpPurpose,
  MfaStepUpVerifiedMethod,
} from './helpers';

const { db, withSystemDbAccessContext, runOutsideDbContext } = dbModule;

// WebAuthn assertion/attestation payloads are large nested objects validated
// structurally by @simplewebauthn; at this layer we only need a string `id` to
// look up the stored credential. Require it so a malformed body is rejected at
// validation (400) instead of falling through to a confusing "passkey not
// registered" (403). Output type stays `any` so it forwards to the WebAuthn
// library's typed verifiers unchanged.
const passkeyNameSchema = z.string().trim().min(1).max(255);
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
  currentPassword: z.string().min(1).max(256)
});

// A pending MFA session may use the passkey endpoints when passkey is either
// the account's primary method OR an available alternate factor. Both /options
// and /verify still independently re-verify that a matching, non-disabled
// credential is owned by the user and that the WebAuthn assertion checks out,
// so this gate only decides whether the passkey path is OFFERED — it never
// substitutes for credential/assertion verification.
function pendingAllowsPasskey(pending: PendingMfaSessionV2): boolean {
  return pending.allowedMethods.includes('passkey') && pending.enrolledMethods.includes('passkey');
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

passkeyRoutes.post('/mfa/step-up/options', authMiddleware, zValidator('json', mfaStepUpOptionsSchema), async (c) => {
  if (!ENABLE_2FA) return mfaDisabledResponse(c);
  const auth = c.get('auth');
  const { purpose, method } = c.req.valid('json');
  let state;
  try {
    state = await loadMfaStepUpFactorState(auth);
  } catch (error) {
    return mfaStepUpErrorResponse(c, error);
  }
  if (!state.allowedExistingMethods.has(method)) {
    return c.json({ error: 'The selected existing MFA factor is unavailable' }, 403);
  }

  const redis = getRedis();
  if (!redis) return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  const rateCheck = await rateLimiter(
    redis,
    `mfa:step-up-options:${auth.user.id}`,
    mfaLimiter.limit * 4,
    mfaLimiter.windowSeconds,
  );
  if (!rateCheck.allowed) return c.json({ error: 'Too many MFA attempts' }, 429);

  if (method === 'passkey') {
    const passkeys = await listActivePasskeys(auth.user.id);
    if (passkeys.length === 0) return c.json({ error: 'The selected existing MFA factor is unavailable' }, 403);
    const options = await generatePasskeyAuthenticationOptions({
      userId: auth.user.id,
      passkeys: passkeys.map(toStoredCredential),
      challengePurpose: 'step-up-authentication',
      stepUpPurpose: purpose,
    });
    return c.json({ method, options });
  }
  if (method === 'sms') {
    const twilio = getTwilioService();
    if (!twilio || !state.user.phoneNumber) {
      return c.json({ error: 'The selected existing MFA factor is unavailable' }, 403);
    }
    const sent = await twilio.sendVerificationCode(state.user.phoneNumber);
    if (!sent.success) return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
    return c.json({ method, phoneLast4: state.user.phoneNumber.slice(-4) });
  }
  return c.json({ method, ready: true });
});

passkeyRoutes.post('/mfa/step-up/verify', authMiddleware, zValidator('json', mfaStepUpVerifySchema), async (c) => {
  if (!ENABLE_2FA) return mfaDisabledResponse(c);
  const auth = c.get('auth');
  const proof = c.req.valid('json');
  const redis = getRedis();
  if (!redis) return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  const rateCheck = await rateLimiter(redis, `mfa:step-up:${auth.user.id}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
  if (!rateCheck.allowed) return c.json({ error: 'Too many MFA attempts' }, 429);

  let state;
  try {
    state = await loadMfaStepUpFactorState(auth);
  } catch (error) {
    return mfaStepUpErrorResponse(c, error);
  }
  if (!state.allowedExistingMethods.has(proof.method)) {
    return c.json({ error: 'Invalid MFA proof' }, 401);
  }

  let valid = false;
  if (proof.method === 'totp') {
    const secret = decryptMfaTotpSecret(state.user.mfaSecret);
    valid = Boolean(secret) && await consumeMFAToken(secret!, proof.code, auth.user.id);
  } else if (proof.method === 'sms') {
    const twilio = getTwilioService();
    if (!twilio || !state.user.phoneNumber) return c.json({ error: 'Invalid MFA proof' }, 401);
    const result = await twilio.checkVerificationCode(state.user.phoneNumber, proof.code);
    if (result.serviceError) return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
    valid = result.valid;
  } else {
    const [passkey] = await db
      .select()
      .from(userPasskeys)
      .where(and(
        eq(userPasskeys.credentialId, proof.credential.id),
        eq(userPasskeys.userId, auth.user.id),
        isNull(userPasskeys.disabledAt),
      ))
      .limit(1);
    if (passkey) {
      try {
        const verification = await verifyPasskeyAuthentication({
          userId: auth.user.id,
          response: proof.credential,
          passkey: toStoredCredential(passkey),
          challengePurpose: 'step-up-authentication',
          stepUpPurpose: proof.purpose,
        });
        valid = verification.verified;
        if (valid) {
          const fields = authenticationInfoToPasskeyUpdateFields(verification);
          await db.update(userPasskeys).set({ ...fields, updatedAt: new Date() }).where(eq(userPasskeys.id, passkey.id));
        }
      } catch (error) {
        if (!(error instanceof PasskeyChallengeError)) throw error;
      }
    }
  }
  if (!valid) return c.json({ error: 'Invalid MFA proof' }, 401);

  let finalState;
  try {
    finalState = await loadMfaStepUpFactorState(auth);
  } catch (error) {
    return mfaStepUpErrorResponse(c, error);
  }
  if (!finalState.allowedExistingMethods.has(proof.method)) {
    return c.json({ error: 'Invalid MFA proof' }, 401);
  }
  try {
    const grant = await issueMfaStepUpGrant({
      ...mfaStepUpBinding(auth, proof.purpose),
      verifiedMethod: proof.method,
    });
    return c.json({ grant, verifiedMethod: proof.method, expiresInSeconds: MFA_STEP_UP_GRANT_TTL_SECONDS });
  } catch (error) {
    return mfaStepUpErrorResponse(c, error);
  }
});

passkeyRoutes.post('/passkeys/register/options', authMiddleware, zValidator('json', passkeyRegisterOptionsSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword, mfaGrant } = c.req.valid('json');
  let state;
  try {
    state = await loadMfaStepUpFactorState(auth);
  } catch (error) {
    return mfaStepUpErrorResponse(c, error);
  }
  let authorization;
  if (state.hasAnyFactor) {
    if (!mfaGrant) return c.json({ error: 'Existing MFA factor proof is required' }, 403);
    try {
      const grantRecord = await readMfaStepUpGrant(mfaGrant, mfaStepUpBinding(auth, 'passkey.register'));
      if (!state.allowedExistingMethods.has(grantRecord.verifiedMethod)) {
        throw new MfaStepUpGrantInvalidError();
      }
    } catch (error) {
      return mfaStepUpErrorResponse(c, error);
    }
    authorization = {
      kind: 'mfa-step-up' as const,
      purpose: 'passkey.register' as const,
      grantHash: hashMfaStepUpGrant(mfaGrant),
    };
  } else {
    if (!currentPassword) return c.json({ error: 'Current password is required for initial enrollment' }, 403);
    const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'passkey:pwd');
    if (passwordError) return passwordError;
    authorization = { kind: 'initial-password' as const };
  }

  const existingPasskeys = await listActivePasskeys(auth.user.id);
  const options = await generatePasskeyRegistrationOptions({
    user: auth.user,
    existingPasskeys: existingPasskeys.map(toStoredCredential),
    authorization,
  });

  return c.json({ options });
});

passkeyRoutes.post('/passkeys/register/verify', authMiddleware, zValidator('json', passkeyRegisterVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { credential, name, mfaGrant } = c.req.valid('json');
  let state;
  try {
    state = await loadMfaStepUpFactorState(auth);
  } catch (error) {
    return mfaStepUpErrorResponse(c, error);
  }
  let grantRecord: MfaStepUpGrantRecord | undefined;
  let authorization;
  if (state.hasAnyFactor) {
    if (!mfaGrant) return c.json({ error: 'Existing MFA factor proof is required' }, 403);
    try {
      grantRecord = await readMfaStepUpGrant(mfaGrant, mfaStepUpBinding(auth, 'passkey.register'));
      if (!state.allowedExistingMethods.has(grantRecord.verifiedMethod)) {
        throw new MfaStepUpGrantInvalidError();
      }
    } catch (error) {
      return mfaStepUpErrorResponse(c, error);
    }
    authorization = {
      kind: 'mfa-step-up' as const,
      purpose: 'passkey.register' as const,
      grantHash: hashMfaStepUpGrant(mfaGrant),
    };
  } else {
    if (mfaGrant) return c.json({ error: 'Initial enrollment requires current-password authorization' }, 403);
    authorization = { kind: 'initial-password' as const };
  }

  let verification;
  try {
    verification = await verifyPasskeyRegistration({
      userId: auth.user.id,
      response: credential,
      authorization,
    });
  } catch (err) {
    if (err instanceof PasskeyChallengeError) {
      return c.json({ error: err.message }, 401);
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
    return c.json({ error: 'Passkey registration failed' }, 401);
  }

  const fields = registrationInfoToPasskeyFields(verification, credential);
  let inserted: PasskeyRow;
  try {
    const mutation = await runLockedMfaMutation(
      lockedMutationInput(auth, 'passkey-added'),
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
        if (!policy.allowedMethods.has('passkey')) throw new MfaStepUpGrantInvalidError();
        const existingMethods = new Set<MfaStepUpVerifiedMethod>();
        if (user.mfaSecret) existingMethods.add('totp');
        if (user.mfaMethod === 'sms' && user.phoneVerified && user.phoneNumber) existingMethods.add('sms');
        if (locked.activePasskeyCount > 0) existingMethods.add('passkey');
        const allowedExistingMethods = new Set(
          [...existingMethods].filter((method) => policy.allowedMethods.has(method)),
        );
        if (existingMethods.size > 0) {
          if (!mfaGrant || !grantRecord || !allowedExistingMethods.has(grantRecord.verifiedMethod)) {
            throw new MfaStepUpGrantInvalidError();
          }
          await consumeMfaStepUpGrant(mfaGrant, {
            ...mfaStepUpBinding(auth, 'passkey.register'),
            verifiedMethod: grantRecord.verifiedMethod,
          });
        } else if (mfaGrant) {
          throw new MfaStepUpGrantInvalidError();
        }

        const [created] = await tx
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
        if (!created) throw new Error('Passkey insert returned no row');

        const hasExistingPrimaryFactor = Boolean(user.mfaSecret) || user.mfaMethod === 'sms';
        await tx
          .update(users)
          .set({
            mfaEnabled: true,
            ...(hasExistingPrimaryFactor ? {} : { mfaMethod: 'passkey' }),
            updatedAt: new Date()
          })
          .where(eq(users.id, auth.user.id));
        return created;
      },
    );
    inserted = mutation.result;
  } catch (error) {
    if (error instanceof MfaAssuranceMutationStaleError) {
      return c.json({ error: 'Authentication state changed. Please sign in again.' }, 401);
    }
    return mfaStepUpErrorResponse(c, error);
  }
  const cleanup = await cleanupMfaAssuranceUsers([auth.user.id]);

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.passkey.register',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'passkey', credentialId: fields.credentialId }
  });

  return c.json({
    success: true,
    reauthenticate: true,
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
    passkey: toPublicPasskey(inserted)
  });
});

passkeyRoutes.post('/mfa/passkey/options', zValidator('json', passkeyMfaOptionsSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const { tempToken } = c.req.valid('json');
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
  if (!pendingAllowsPasskey(pending)) {
    return c.json({ error: 'Passkey MFA is not configured for this session' }, 400);
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
  if (!pendingAllowsPasskey(pending)) {
    return c.json({ error: 'Passkey MFA is not configured for this session' }, 400);
  }

  // Rate limit assertion attempts, mirroring the TOTP path in mfa.ts.
  const rateCheck = await rateLimiter(redis, `mfa:${pending.userId}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many MFA attempts' }, 429);
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

  let verification;
  try {
    verification = await verifyPasskeyAuthentication({
      userId: pending.userId,
      response: credential,
      passkey: toStoredCredential(passkey)
    });
  } catch (err) {
    if (err instanceof PasskeyChallengeError) {
      return c.json({ error: err.message }, 401);
    }
    throw err;
  }

  if (!verification.verified) {
    return c.json({ error: 'Passkey verification failed' }, 401);
  }

  const updateFields = authenticationInfoToPasskeyUpdateFields(verification);
  // System DB context required: passkey MFA runs before the user is
  // authenticated, so without it this `user_passkeys` RLS UPDATE silently
  // matches 0 rows under breeze_app (Shape 6: user_id = breeze_current_user_id()
  // OR scope = 'system'). last_used_at never moves AND the WebAuthn signature
  // counter is never persisted — defeating clone detection. Same root cause as
  // the users.last_login_at update below (#2210, #1375).
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

  let completed;
  try {
    completed = await issueVerifiedPendingMfaSession({
      tempToken,
      expectedPending: pending,
      verifiedMethod: 'passkey',
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
  const { user, tokens, authority } = completed;

  // System DB context required: passkey login is unauthenticated at this point,
  // so without it the `users` RLS UPDATE silently matches 0 rows under
  // breeze_app and last_login_at never moves (#1375).
  await withSystemDbAccessContext(() =>
    db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id))
  );

  auditLogin(c, {
    orgId: authority.orgId ?? null,
    userId: user.id,
    email: user.email,
    name: user.name,
    mfa: true,
    scope: authority.scope,
    ip: getClientIP(c)
  });

  setRefreshTokenCookie(c, tokens.refreshToken);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: true
    },
    tokens: toPublicTokens(tokens),
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
  const { currentPassword } = c.req.valid('json');

  if (auth.token.mfa !== true) {
    return c.json({ error: 'MFA verification is required to delete a passkey' }, 403);
  }

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'passkey:pwd');
  if (passwordError) return passwordError;

  try {
    await runLockedMfaMutation(
      lockedMutationInput(auth, 'passkey-deleted'),
      async (tx, locked) => {
        const [passkey] = await tx
          .select()
          .from(userPasskeys)
          .where(and(
            eq(userPasskeys.id, id),
            eq(userPasskeys.userId, auth.user.id),
            isNull(userPasskeys.disabledAt),
          ))
          .limit(1);
        if (!passkey) throw new Error('PASSKEY_NOT_FOUND');
        const user = locked.user!;
        const policy = await resolveEffectiveMfaPolicy({
          userId: auth.user.id,
          roleId: auth.token.roleId,
          orgId: auth.token.orgId,
          partnerId: auth.token.partnerId,
          scope: auth.token.scope,
          tx,
        });
        const hasTotp = Boolean(user.mfaSecret);
        const hasSms = user.mfaMethod === 'sms' && user.phoneVerified === true && Boolean(user.phoneNumber);
        const remainingPasskeys = Math.max(0, locked.activePasskeyCount - 1);
        const remainingFactorCount = remainingPasskeys + (hasTotp ? 1 : 0) + (hasSms ? 1 : 0);
        if (policy.required && remainingFactorCount === 0) throw new Error('LAST_REQUIRED_FACTOR');
        await tx.delete(userPasskeys).where(eq(userPasskeys.id, id));
        if (remainingFactorCount === 0) {
          await tx.update(users).set({ mfaEnabled: false, mfaMethod: null, updatedAt: new Date() })
            .where(eq(users.id, auth.user.id));
        } else if (user.mfaMethod === 'passkey' && remainingPasskeys === 0) {
          await tx.update(users).set({
            mfaEnabled: true,
            mfaMethod: hasTotp ? 'totp' : 'sms',
            updatedAt: new Date(),
          }).where(eq(users.id, auth.user.id));
        }
      },
    );
  } catch (error) {
    if (error instanceof MfaAssuranceMutationStaleError) {
      return c.json({ error: 'Authentication state changed. Please sign in again.' }, 401);
    }
    if (error instanceof Error && error.message === 'PASSKEY_NOT_FOUND') {
      return c.json({ error: 'Passkey not found' }, 404);
    }
    if (error instanceof Error && error.message === 'LAST_REQUIRED_FACTOR') {
      return c.json({ error: 'Cannot remove the last MFA factor while your role or organization requires MFA' }, 403);
    }
    throw error;
  }
  const cleanup = await cleanupMfaAssuranceUsers([auth.user.id]);

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.passkey.delete',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'passkey', passkeyId: id }
  });

  return c.json({
    success: true,
    reauthenticate: true,
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
});

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

function mfaStepUpBinding(
  auth: AuthContext,
  purpose: MfaStepUpPurpose,
): MfaStepUpGrantExpectedBinding {
  const { sid, ae, me } = auth.token;
  if (!sid || !Number.isSafeInteger(ae) || !Number.isSafeInteger(me) || ae < 1 || me < 1) {
    throw new MfaStepUpGrantInvalidError();
  }
  return {
    purpose,
    userId: auth.user.id,
    sessionId: sid,
    authEpoch: ae,
    mfaEpoch: me,
  };
}

function lockedMutationInput(auth: AuthContext, reason: string) {
  const binding = mfaStepUpBinding(auth, 'passkey.register');
  return {
    userId: auth.user.id,
    partnerId: auth.token.partnerId,
    authEpoch: binding.authEpoch,
    mfaEpoch: binding.mfaEpoch,
    reason,
  };
}

async function loadMfaStepUpFactorState(auth: AuthContext) {
  const binding = mfaStepUpBinding(auth, 'passkey.register');
  return withAuthLifecycleSystemTransaction(async (tx) => {
    const { user, activePasskeyCount } = await lockMfaAssuranceState(tx, {
      partnerId: auth.token.partnerId,
      userId: auth.user.id,
    });
    if (!user
      || user.id !== auth.user.id
      || user.status !== 'active'
      || user.authEpoch !== binding.authEpoch
      || user.mfaEpoch !== binding.mfaEpoch) {
      throw new MfaStepUpGrantInvalidError();
    }
    const policy = await resolveEffectiveMfaPolicy({
      userId: auth.user.id,
      roleId: auth.token.roleId,
      orgId: auth.token.orgId,
      partnerId: auth.token.partnerId,
      scope: auth.token.scope,
      tx,
    });
    const existingMethods = new Set<MfaStepUpVerifiedMethod>();
    if (typeof user.mfaSecret === 'string' && user.mfaSecret.length > 0) existingMethods.add('totp');
    if (user.mfaMethod === 'sms' && user.phoneVerified && user.phoneNumber) existingMethods.add('sms');
    if (activePasskeyCount > 0) existingMethods.add('passkey');
    const allowedExistingMethods = new Set(
      [...existingMethods].filter((method) => policy.allowedMethods.has(method)),
    );
    return {
      user,
      hasAnyFactor: existingMethods.size > 0,
      existingMethods,
      allowedExistingMethods,
    };
  });
}

function mfaStepUpErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof MfaStepUpGrantUnavailableError) {
    return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  }
  if (error instanceof MfaStepUpGrantInvalidError) {
    return c.json({ error: 'Invalid or expired MFA step-up authorization' }, 401);
  }
  throw error;
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
