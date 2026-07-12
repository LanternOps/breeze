import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { userPasskeys, users } from '../../db/schema';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import {
  getRedis,
  issueVerifiedPendingMfaSession,
  mfaLimiter,
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  rateLimiter,
  readPendingMfa,
  type PendingMfaSessionV2,
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
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import { ENABLE_2FA } from './schemas';
import {
  auditLogin,
  getClientIP,
  mfaDisabledResponse,
  requireCurrentPasswordStepUp,
  setRefreshTokenCookie,
  toPublicTokens,
  userRequiresSetup,
  writeAuthAudit
} from './helpers';

const { db, withSystemDbAccessContext, runOutsideDbContext } = dbModule;

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
const registerOptionsSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  name: passkeyNameSchema.optional()
});
const registerVerifySchema = z.object({
  credential: webAuthnCredentialSchema,
  name: passkeyNameSchema.optional()
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

passkeyRoutes.post('/passkeys/register/options', authMiddleware, zValidator('json', registerOptionsSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { currentPassword } = c.req.valid('json');

  const passwordError = await requireCurrentPasswordStepUp(c, auth.user.id, currentPassword, 'passkey:pwd');
  if (passwordError) return passwordError;

  const existingPasskeys = await listActivePasskeys(auth.user.id);
  const options = await generatePasskeyRegistrationOptions({
    user: auth.user,
    existingPasskeys: existingPasskeys.map(toStoredCredential)
  });

  return c.json({ options });
});

passkeyRoutes.post('/passkeys/register/verify', authMiddleware, zValidator('json', registerVerifySchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const auth = c.get('auth');
  const { credential, name } = c.req.valid('json');

  let verification;
  try {
    verification = await verifyPasskeyRegistration({
      userId: auth.user.id,
      response: credential
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
  const [inserted] = await db
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

  if (!inserted) {
    throw new Error('Passkey insert returned no row');
  }

  // Enable MFA, but do NOT overwrite an existing TOTP/SMS factor's method.
  // `mfaMethod` is single-valued and drives login routing (login.ts/mfa.ts);
  // clobbering it to 'passkey' would strand a user's working authenticator
  // and risk lockout if they later lose the passkey device. Only make passkey
  // the primary method when the user has no other factor configured.
  const [currentMfa] = await db
    .select({ mfaSecret: users.mfaSecret, mfaMethod: users.mfaMethod })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  const hasExistingFactor = Boolean(currentMfa?.mfaSecret) || currentMfa?.mfaMethod === 'sms';

  await db
    .update(users)
    .set({
      mfaEnabled: true,
      ...(hasExistingFactor ? {} : { mfaMethod: 'passkey' }),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

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

  const [passkey] = await findOwnedPasskey(id, auth.user.id);
  if (!passkey) {
    return c.json({ error: 'Passkey not found' }, 404);
  }

  const factorState = await getMfaFactorState(auth);
  const remainingFactorCount =
    Math.max(0, factorState.passkeyCount - 1)
    + (factorState.hasTotp ? 1 : 0)
    + (factorState.hasSms ? 1 : 0);

  if (factorState.mfaRequired && remainingFactorCount === 0) {
    return c.json({ error: 'Cannot remove the last MFA factor while your role or organization requires MFA' }, 403);
  }

  await db
    .delete(userPasskeys)
    .where(eq(userPasskeys.id, id));

  if (remainingFactorCount === 0) {
    await db
      .update(users)
      .set({
        mfaEnabled: false,
        mfaMethod: null,
        updatedAt: new Date()
      })
      .where(eq(users.id, auth.user.id));
  } else if (factorState.currentMfaMethod === 'passkey' && factorState.passkeyCount - 1 === 0) {
    await db
      .update(users)
      .set({
        mfaEnabled: true,
        mfaMethod: factorState.hasTotp ? 'totp' : 'sms',
        updatedAt: new Date()
      })
      .where(eq(users.id, auth.user.id));
  }

  writeAuthAudit(c, {
    orgId: auth.orgId ?? undefined,
    action: 'auth.mfa.passkey.delete',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
    details: { method: 'passkey', passkeyId: id }
  });

  return c.json({ success: true });
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

async function getMfaFactorState(auth: AuthContext): Promise<{
  passkeyCount: number;
  hasTotp: boolean;
  hasSms: boolean;
  currentMfaMethod: 'totp' | 'sms' | 'passkey' | null;
  mfaRequired: boolean;
}> {
  // This runs inside the DELETE handler's request (user-scoped) context, where
  // a bare `withSystemDbAccessContext` would be a no-op. Escape the active
  // context first so the roles / partner_users / organization_users /
  // organizations reads that decide `mfaRequired` actually run under system
  // scope — otherwise user-scoped RLS could hide a force_mfa role/org-setting
  // row, under-count factors, and let the last MFA factor be removed.
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
        currentMfaMethod: users.mfaMethod,
        forceMfa: sql<boolean>`EXISTS (
          SELECT 1
          FROM roles r
          LEFT JOIN partner_users pu ON pu.role_id = r.id
          LEFT JOIN organization_users ou ON ou.role_id = r.id
          WHERE (pu.user_id = ${auth.user.id} OR ou.user_id = ${auth.user.id})
            AND r.force_mfa = true
        )`,
        orgRequiresMfa: auth.orgId
          ? sql<boolean>`EXISTS (
              SELECT 1
              FROM organizations o
              WHERE o.id = ${auth.orgId}
                AND COALESCE((o.settings->'security'->>'requireMfa')::boolean, false) = true
            )`
          : sql<boolean>`false`
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
    mfaRequired: Boolean((state as { forceMfa?: boolean; orgRequiresMfa?: boolean } | undefined)?.forceMfa || (state as { forceMfa?: boolean; orgRequiresMfa?: boolean } | undefined)?.orgRequiresMfa)
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
