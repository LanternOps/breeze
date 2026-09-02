import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partners, organizations } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  getRedis,
  rateLimiter,
} from '../../services';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  cancelAuthIssuance,
  finishAuthIssuance,
} from '../../services/authBrowserTransition';
import {
  authBrowserTransitionsEnforced,
  bindIssuedUserSession,
  issueUserSession,
  issueUserSessionLegacyDuringTransition,
  type UserSessionIdentity,
} from '../../services/userSession';
import {
  advanceUserEpochs,
  lockActiveRefreshFamiliesForUsers,
  revokeAllRefreshFamilies,
} from '../../services/authLifecycle';
import { recordAuthTransitionLegacyIssuer } from '../../services/authTransitionMetrics';
import { acceptInviteSchema, invitePreviewSchema } from './schemas';
import {
  getClientRateLimitKey,
  resolveCurrentUserTokenContext,
  resolveUserAuditOrgId,
  writeAuthAudit,
  toPublicTokens,
  hashInviteToken,
  inviteRedisKey,
  inviteUserRedisKey,
  isAuthTransitionV1Request,
  authClientUpgradeRequiredResponse,
  installAuthorizedUserSessionCookies,
  installLegacyUserSessionCookiesDuringTransition,
} from './helpers';
import { installAuthBindingReplacement, requestAuthBinding } from './binding';

const { db, withSystemDbAccessContext } = dbModule;

export const inviteRoutes = new Hono();

function inviteIssuanceError(c: Context, error: unknown): Response | null {
  if (error instanceof AuthBindingRotationRequiredError) {
    installAuthBindingReplacement(c, error.replacement);
    return c.json({
      error: 'Authentication binding refresh required',
      reason: 'binding_refresh',
    }, 428);
  }
  if (
    error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError
  ) {
    return c.json({ error: 'Authentication temporarily unavailable' }, 409);
  }
  return null;
}

function setInviteTokenNoStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

async function handleInvitePreview(c: Context, token: string) {
  setInviteTokenNoStore(c);
  if (!token) return c.json({ error: 'missing token' }, 400);

  const rateLimitClient = getClientRateLimitKey(c);
  const redis = getRedis();
  if (!redis) return c.json({ error: 'unavailable' }, 503);

  const rateCheck = await rateLimiter(redis, `invite-preview:${rateLimitClient}`, 30, 600);
  if (!rateCheck.allowed) return c.json({ error: 'rate_limited' }, 429);

  const tokenHash = hashInviteToken(token);
  const userId = await redis.get(inviteRedisKey(tokenHash));
  if (!userId) return c.json({ error: 'invalid_or_expired' }, 404);

  const [row] = await withSystemDbAccessContext(async () =>
    db
      .select({
        email: users.email,
        name: users.name,
        status: users.status,
        partnerName: partners.name,
        orgName: organizations.name,
      })
      .from(users)
      .leftJoin(partners, eq(partners.id, users.partnerId))
      .leftJoin(organizations, eq(organizations.id, users.orgId))
      .where(eq(users.id, userId))
      .limit(1),
  );

  if (!row) return c.json({ error: 'invalid_or_expired' }, 404);
  if (row.status !== 'invited') return c.json({ error: 'already_accepted' }, 410);

  return c.json({
    email: row.email,
    name: row.name,
    partnerName: row.partnerName ?? undefined,
    orgName: row.orgName ?? undefined,
  });
}

inviteRoutes.post('/invite/preview', zValidator('json', invitePreviewSchema), async (c) => {
  const { token } = c.req.valid('json');
  return handleInvitePreview(c, token);
});

inviteRoutes.get('/invite/preview/:token', async (c) => {
  if (process.env.AUTH_LEGACY_INVITE_PREVIEW_PATH !== '1') {
    setInviteTokenNoStore(c);
    return c.json({ error: 'Invite preview tokens must be submitted in the request body' }, 410);
  }
  return handleInvitePreview(c, c.req.param('token'));
});

inviteRoutes.post('/accept-invite', zValidator('json', acceptInviteSchema), async (c) => {
  setInviteTokenNoStore(c);
  const { token, password } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Rate limit by IP
  const rateCheck = await rateLimiter(redis, `accept-invite:${rateLimitClient}`, 10, 3600);
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
  }

  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  const tokenHash = hashInviteToken(token);
  const userId = await redis.get(inviteRedisKey(tokenHash));

  if (!userId) {
    return c.json({ error: 'Invalid or expired invite token' }, 400);
  }

  // Pre-auth lookup — wrap in system scope so the `users` RLS policy
  // doesn't deny the read before the real request scope is applied.
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        authEpoch: users.authEpoch,
        mfaEpoch: users.mfaEpoch,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );

  if (!user) {
    return c.json({ error: 'User not found' }, 400);
  }

  if (user.status !== 'invited') {
    return c.json({ error: 'This invite has already been accepted' }, 400);
  }

  const transitionV1 = isAuthTransitionV1Request(c);
  if (!transitionV1 && authBrowserTransitionsEnforced()) {
    return authClientUpgradeRequiredResponse(c);
  }

  const context = await resolveCurrentUserTokenContext(userId);
  const identity: UserSessionIdentity = {
    userId: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: false,
  };
  const passwordHash = await hashPassword(password);

  if (!transitionV1) {
    try {
      await withSystemDbAccessContext(() => db.transaction(async (tx) => {
        const activated = await tx
          .update(users)
          .set({
            passwordHash,
            status: 'active',
            passwordChangedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(users.id, userId), eq(users.status, 'invited')))
          .returning({ id: users.id });
        if (activated.length !== 1) throw new Error('Invite is no longer available');
        await advanceUserEpochs(tx, userId, { auth: true, passwordReset: true });
        await lockActiveRefreshFamiliesForUsers(tx, [userId]);
        await revokeAllRefreshFamilies(tx, userId, 'invite_accepted');
      }));

      recordAuthTransitionLegacyIssuer('invite', 'web');
      const issued = await issueUserSessionLegacyDuringTransition(identity);
      installLegacyUserSessionCookiesDuringTransition(c, issued);

      await redis.del(inviteRedisKey(tokenHash)).catch((err: unknown) => {
        console.error('[AcceptInvite] Failed to delete invite token after commit:', err);
      });
      await redis.del(inviteUserRedisKey(userId)).catch((err: unknown) => {
        console.error('[AcceptInvite] Failed to delete invite-user key after commit:', err);
      });

      const auditOrgId = await resolveUserAuditOrgId(userId);
      writeAuthAudit(c, {
        orgId: auditOrgId ?? undefined,
        action: 'user.invite.accepted',
        result: 'success',
        userId: user.id,
        email: user.email,
        name: user.name,
      });
      writeAuthAudit(c, {
        orgId: auditOrgId ?? undefined,
        action: 'user.password.set',
        result: 'success',
        userId: user.id,
        email: user.email,
        name: user.name,
      });

      return c.json({
        user: { id: user.id, email: user.email, name: user.name, mfaEnabled: false },
        tokens: toPublicTokens(issued),
      });
    } catch (err) {
      console.error(`[AcceptInvite] Failed to activate user ${userId}:`, err);
      return c.json({ error: 'Failed to activate account. Please try again.' }, 500);
    }
  }

  let capability;
  try {
    capability = await beginAuthIssuance(requestAuthBinding(c));
    const guardedCapability = capability;
    const issued = await finishAuthIssuance(guardedCapability, async (tx) => {
      const activated = await tx
        .update(users)
        .set({
          passwordHash,
          status: 'active',
          passwordChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(users.id, userId),
          eq(users.status, 'invited'),
          eq(users.authEpoch, user.authEpoch),
          eq(users.mfaEpoch, user.mfaEpoch),
        ))
        .returning({ id: users.id });
      if (activated.length !== 1) throw new AuthIssuanceCapabilityError();

      const epochs = await advanceUserEpochs(tx, userId, { auth: true, passwordReset: true });
      await lockActiveRefreshFamiliesForUsers(tx, [userId]);
      await revokeAllRefreshFamilies(tx, userId, 'invite_accepted');
      return issueUserSession(identity, {
        tx,
        capability: guardedCapability,
        expectedEpochs: { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch },
      });
    });

    await bindIssuedUserSession(issued);
    await redis.del(inviteRedisKey(tokenHash)).catch((err: unknown) => {
      console.error('[AcceptInvite] Failed to delete invite token after commit:', err);
    });
    await redis.del(inviteUserRedisKey(userId)).catch((err: unknown) => {
      console.error('[AcceptInvite] Failed to delete invite-user key after commit:', err);
    });
    installAuthorizedUserSessionCookies(c, issued);

    const auditOrgId = await resolveUserAuditOrgId(userId);
    writeAuthAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'user.invite.accepted',
      result: 'success',
      userId: user.id,
      email: user.email,
      name: user.name,
    });
    writeAuthAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'user.password.set',
      result: 'success',
      userId: user.id,
      email: user.email,
      name: user.name,
    });

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: false,
      },
      tokens: toPublicTokens(issued),
    });
  } catch (err) {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
    const response = inviteIssuanceError(c, err);
    if (response) return response;
    console.error(`[AcceptInvite] Failed guarded activation for ${userId}:`, err);
    return c.json({ error: 'Failed to activate account. Please try again.' }, 500);
  }
});
