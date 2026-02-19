import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  hashPassword,
  isPasswordStrong,
  getRedis,
  createTokenPair,
} from '../../services';
import { acceptInviteSchema } from './schemas';
import {
  resolveCurrentUserTokenContext,
  toPublicTokens,
  setRefreshTokenCookie,
} from './helpers';

const { db } = dbModule;

export const inviteRoutes = new Hono();

// Accept invite — public endpoint
inviteRoutes.post('/accept-invite', zValidator('json', acceptInviteSchema), async (c) => {
  const { token, password } = c.req.valid('json');

  // Validate password strength
  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Look up invite token in Redis
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const userId = await redis.get(`invite:${tokenHash}`);

  if (!userId) {
    return c.json({ error: 'Invalid or expired invite token' }, 400);
  }

  // Verify user exists and has 'invited' status
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

  // Hash password and activate user
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

  // Delete invite token (single-use)
  await redis.del(`invite:${tokenHash}`);

  // Resolve user context and create token pair for auto-login
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
});
