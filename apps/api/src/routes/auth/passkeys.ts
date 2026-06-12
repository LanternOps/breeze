import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { userPasskeys, users } from '../../db/schema';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import {
  bindRefreshJtiToFamily,
  createTokenPair,
  getRedis,
  mintRefreshTokenFamily
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
  resolveCurrentUserTokenContext,
  setRefreshTokenCookie,
  toPublicTokens,
  userRequiresSetup,
  writeAuthAudit
} from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

const passkeyNameSchema = z.string().trim().min(1).max(255);
const registerOptionsSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  name: passkeyNameSchema.optional()
});
const registerVerifySchema = z.object({
  credential: z.any(),
  name: passkeyNameSchema.optional()
});
const passkeyMfaOptionsSchema = z.object({
  tempToken: z.string().min(1)
});
const passkeyMfaVerifySchema = z.object({
  tempToken: z.string().min(1),
  credential: z.any()
});
const renamePasskeySchema = z.object({
  name: passkeyNameSchema
});
const deletePasskeySchema = z.object({
  currentPassword: z.string().min(1).max(256)
});

type PendingPasskeyMfa = {
  userId: string;
  mfaMethod: string;
};

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

  await db
    .update(users)
    .set({
      mfaEnabled: true,
      mfaMethod: 'passkey',
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
    passkey: toPublicPasskey({
      id: inserted?.id ?? fields.credentialId,
      userId: auth.user.id,
      credentialId: fields.credentialId,
      publicKey: fields.publicKey,
      counter: fields.counter,
      deviceType: fields.deviceType,
      backedUp: fields.backedUp,
      transports: fields.transports,
      name: name ?? 'Passkey',
      aaguid: fields.aaguid,
      lastUsedAt: null,
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  });
});

passkeyRoutes.post('/mfa/passkey/options', zValidator('json', passkeyMfaOptionsSchema), async (c) => {
  if (!ENABLE_2FA) {
    return mfaDisabledResponse(c);
  }

  const { tempToken } = c.req.valid('json');
  const pending = await readPendingPasskeyMfa(tempToken);
  if (!pending) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  if (pending.mfaMethod !== 'passkey') {
    return c.json({ error: 'Passkey MFA is not configured for this session' }, 400);
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

  const { tempToken, credential } = c.req.valid('json');
  const pending = await readPendingPasskeyMfa(tempToken);
  if (!pending) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }
  if (pending.mfaMethod !== 'passkey') {
    return c.json({ error: 'Passkey MFA is not configured for this session' }, 400);
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
  await db
    .update(userPasskeys)
    .set({
      counter: updateFields.counter,
      deviceType: updateFields.deviceType,
      backedUp: updateFields.backedUp,
      lastUsedAt: updateFields.lastUsedAt,
      updatedAt: new Date()
    })
    .where(eq(userPasskeys.id, passkey.id));

  await getRedis()?.del(`mfa:pending:${tempToken}`);

  const context = await resolveCurrentUserTokenContext(user.id);
  const familyId = await mintRefreshTokenFamily(user.id);
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: true,
    mdid: readMobileDeviceId(c) ?? undefined
  }, { refreshFam: familyId });
  await bindRefreshJtiToFamily(tokens.refreshJti, familyId);

  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  auditLogin(c, {
    orgId: context.orgId ?? null,
    userId: user.id,
    email: user.email,
    name: user.name,
    mfa: true,
    scope: context.scope,
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

  await db
    .update(userPasskeys)
    .set({ name, updatedAt: new Date() })
    .where(eq(userPasskeys.id, id));

  return c.json({ success: true, passkey: { ...toPublicPasskey(passkey), name } });
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

async function readPendingPasskeyMfa(tempToken: string): Promise<PendingPasskeyMfa | null> {
  const redis = getRedis();
  if (!redis) {
    return null;
  }

  const raw = await redis.get(`mfa:pending:${tempToken}`);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PendingPasskeyMfa>;
    if (typeof parsed.userId !== 'string') return null;
    return {
      userId: parsed.userId,
      mfaMethod: parsed.mfaMethod || 'totp'
    };
  } catch {
    return {
      userId: raw,
      mfaMethod: 'totp'
    };
  }
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
}> {
  const [state] = await withSystemDbAccessContext(async () =>
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
  );

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
