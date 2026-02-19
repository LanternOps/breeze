import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  getRedis,
  createTokenPair,
  rateLimiter,
} from '../../services';
import { acceptInviteSchema } from './schemas';
import {
  getClientIP,
  resolveCurrentUserTokenContext,
  resolveUserAuditOrgId,
  writeAuthAudit,
  toPublicTokens,
  setRefreshTokenCookie,
  hashInviteToken,
  inviteRedisKey,
  inviteUserRedisKey,
} from './helpers';

const { db } = dbModule;

export const inviteRoutes = new Hono();

inviteRoutes.post('/accept-invite', zValidator('json', acceptInviteSchema), async (c) => {
  const { token, password } = c.req.valid('json');
  const ip = getClientIP(c);

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Rate limit by IP
  const rateCheck = await rateLimiter(redis, `accept-invite:${ip}`, 10, 3600);
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

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ error: 'User not found' }, 400);
  }

  if (user.status !== 'invited') {
    return c.json({ error: 'This invite has already been accepted' }, 400);
  }

  // Activate the user account
  try {
    const passwordHash = await hashPassword(password);

    await db
      .update(users)
      .set({
        passwordHash,
        status: 'active',
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Clean up invite tokens (single-use)
    await redis.del(inviteRedisKey(tokenHash)).catch((err: unknown) => {
      console.error('[AcceptInvite] Failed to delete invite token:', err);
    });
    await redis.del(inviteUserRedisKey(userId)).catch((err: unknown) => {
      console.error('[AcceptInvite] Failed to delete invite-user key:', err);
    });
  } catch (err) {
    console.error(`[AcceptInvite] Failed to activate user ${userId}:`, err);
    return c.json({ error: 'Failed to activate account. Please try again.' }, 500);
  }

  // Audit log
  const auditOrgId = await resolveUserAuditOrgId(userId);
  if (auditOrgId) {
    writeAuthAudit(c, {
      orgId: auditOrgId,
      action: 'user.invite.accepted',
      result: 'success',
      userId: user.id,
      email: user.email,
      name: user.name,
    });
  }

  // Auto-login: resolve context and create tokens
  try {
    const context = await resolveCurrentUserTokenContext(userId);

    const tokens = await createTokenPair({
      sub: user.id,
      email: user.email,
      roleId: context.roleId,
      orgId: context.orgId,
      partnerId: context.partnerId,
      scope: context.scope,
      mfa: false,
    });

    setRefreshTokenCookie(c, tokens.refreshToken);

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: false,
      },
      tokens: toPublicTokens(tokens),
    });
  } catch (err) {
    console.error(`[AcceptInvite] Account activated but auto-login failed for ${userId}:`, err);
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: false,
      },
      tokens: null,
      message: 'Account activated. Please sign in manually.',
    });
  }
});
