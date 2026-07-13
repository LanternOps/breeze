import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partners, organizations } from '../../db/schema';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  bindIssuedUserSession,
  cancelAuthIssuance,
  finishAuthIssuance,
  hashPassword,
  isPasswordStrong,
  getRedis,
  issueUserSession,
  rateLimiter,
} from '../../services';
import { acceptInviteSchema, CSRF_COOKIE_NAME, invitePreviewSchema } from './schemas';
import {
  getCookieValue,
  getClientRateLimitKey,
  rotateCsrfBindingCookie,
  resolveCurrentUserTokenContext,
  resolveUserAuditOrgId,
  writeAuthAudit,
  toPublicTokens,
  setRefreshTokenCookie,
  hashInviteToken,
  inviteRedisKey,
  inviteUserRedisKey,
} from './helpers';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
  type AuthLifecycleTransaction,
} from '../../services/authLifecycle';
import type { AuthIssuanceCapability } from '../../services/authBrowserTransition';

const { db, withSystemDbAccessContext } = dbModule;

export const inviteRoutes = new Hono();

class InviteAlreadyAcceptedError extends Error {}

export async function activateInvitedUserSession(input: {
  tx: AuthLifecycleTransaction;
  capability: AuthIssuanceCapability;
  userId: string;
  passwordHash: string;
}) {
  const [lockedUser] = await input.tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for('update');
  if (!lockedUser) throw new Error(`Invited user ${input.userId} disappeared`);
  if (lockedUser.status !== 'invited') throw new InviteAlreadyAcceptedError();

  const [updated] = await input.tx
    .update(users)
    .set({
      passwordHash: input.passwordHash,
      status: 'active',
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, input.userId), eq(users.status, 'invited')))
    .returning({ id: users.id });
  if (!updated) throw new InviteAlreadyAcceptedError();

  await advanceUserSecurityState(input.tx, input.userId);
  await revokeAllUserSessionFamilies(input.tx, input.userId, 'invite-accepted');
  const context = await resolveCurrentUserTokenContext(input.userId);
  const tokens = await issueUserSession({
    userId: lockedUser.id,
    email: lockedUser.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: false,
    amr: ['password'],
  }, { tx: input.tx, capability: input.capability });
  return { user: lockedUser, tokens };
}

function inviteTransitionErrorResponse(c: Context, error: unknown) {
  if (error instanceof AuthBindingRotationRequiredError) {
    rotateCsrfBindingCookie(c, error.replacement.value);
    return c.json({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }, 428);
  }
  if (error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError) {
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

  // Hash outside the transaction so the browser-transition row is never held
  // across CPU-intensive password work.
  const passwordHash = await hashPassword(password);
  let capability: Awaited<ReturnType<typeof beginAuthIssuance>> | undefined;
  let committed: {
    user: { id: string; email: string; name: string | null };
    tokens: Awaited<ReturnType<typeof issueUserSession>>;
  };

  try {
    const admission = await beginAuthIssuance({
      kind: 'browser',
      value: getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME) ?? '',
    });
    capability = admission;
    committed = await finishAuthIssuance(admission, (tx) =>
      activateInvitedUserSession({
        tx,
        capability: admission,
        userId,
        passwordHash,
      }));
  } catch (err) {
    if (capability) await cancelAuthIssuance(capability).catch(() => false);
    const transitionResponse = inviteTransitionErrorResponse(c, err);
    if (transitionResponse) return transitionResponse;
    if (err instanceof InviteAlreadyAcceptedError) {
      return c.json({ error: 'This invite has already been accepted' }, 400);
    }
    console.error(`[AcceptInvite] Failed to activate user ${userId}:`, err);
    return c.json({ error: 'Failed to activate account. Please try again.' }, 500);
  }

  // Everything below is post-commit: Redis is a cache/single-use accelerator,
  // audit delivery is non-authoritative, and cookies are response state.
  let auditFailure: unknown;
  try {
    const auditOrgId = await resolveUserAuditOrgId(userId);
    writeAuthAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'user.invite.accepted',
      result: 'success',
      userId: committed.user.id,
      email: committed.user.email,
      name: committed.user.name ?? undefined,
    });
    writeAuthAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'user.password.set',
      result: 'success',
      userId: committed.user.id,
      email: committed.user.email,
      name: committed.user.name ?? undefined,
    });
  } catch (error) {
    auditFailure = error;
  }

  const postCommitResults = await Promise.allSettled([
    bindIssuedUserSession(committed.tokens),
    redis.del(inviteRedisKey(tokenHash)),
    redis.del(inviteUserRedisKey(userId)),
  ]);
  const postCommitFailure = postCommitResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (auditFailure || postCommitFailure) {
    const failure = auditFailure ?? postCommitFailure?.reason;
    console.error(`[AcceptInvite] Account activated but post-commit session/cache delivery failed for ${userId}:`, failure);
    return c.json({
      user: {
        id: committed.user.id,
        email: committed.user.email,
        name: committed.user.name,
        mfaEnabled: false,
      },
      tokens: null,
      message: 'Account activated. Please sign in manually.',
    });
  }

  try {
    setRefreshTokenCookie(c, committed.tokens.refreshToken);

    return c.json({
      user: {
        id: committed.user.id,
        email: committed.user.email,
        name: committed.user.name,
        mfaEnabled: false,
      },
      tokens: toPublicTokens(committed.tokens),
    });
  } catch (err) {
    console.error(`[AcceptInvite] Account activated but cookie delivery failed for ${userId}:`, err);
    return c.json({
      user: {
        id: committed.user.id,
        email: committed.user.email,
        name: committed.user.name,
        mfaEnabled: false,
      },
      tokens: null,
      message: 'Account activated. Please sign in manually.',
    });
  }
});
