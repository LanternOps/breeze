import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalUsers } from '../../db/schema';
import { hashPassword, isPasswordStrong, verifyPassword } from '../../services/password';
import { getRedis } from '../../services/redis';
import {
  updateProfileSchema,
  changePasswordSchema,
  PORTAL_USE_REDIS,
  PORTAL_REDIS_KEYS,
} from './schemas';
import {
  portalSessions,
  buildPortalUserPayload,
  validatePortalCookieCsrfRequest,
  writePortalAudit,
} from './helpers';

export const profileRoutes = new Hono();

profileRoutes.get('/profile', async (c) => {
  const auth = c.get('portalAuth');
  return c.json({ user: buildPortalUserPayload(auth.user) });
});

profileRoutes.patch('/profile', zValidator('json', updateProfileSchema), async (c) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) {
    return c.json({ error: csrfError }, 403);
  }

  const auth = c.get('portalAuth');
  const payload = c.req.valid('json');
  const updates: {
    name?: string;
    receiveNotifications?: boolean;
    passwordHash?: string;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (payload.name !== undefined) {
    updates.name = payload.name;
  }

  if (payload.receiveNotifications !== undefined) {
    updates.receiveNotifications = payload.receiveNotifications;
  }

  if (payload.password) {
    const passwordCheck = isPasswordStrong(payload.password);
    if (!passwordCheck.valid) {
      return c.json({ error: passwordCheck.errors[0] }, 400);
    }
    updates.passwordHash = await hashPassword(payload.password);
  }

  const userResult = await db
    .update(portalUsers)
    .set(updates)
    .where(eq(portalUsers.id, auth.user.id))
    .returning({
      id: portalUsers.id,
      orgId: portalUsers.orgId,
      email: portalUsers.email,
      name: portalUsers.name,
      receiveNotifications: portalUsers.receiveNotifications,
      status: portalUsers.status
    });

  const user = userResult[0];
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  writePortalAudit(c, {
    orgId: user.orgId,
    actorType: 'user',
    actorId: user.id,
    actorEmail: user.email,
    action: 'portal.profile.update',
    resourceType: 'portal_user',
    resourceId: user.id,
    resourceName: user.name ?? user.email,
    details: {
      updatedFields: Object.keys(payload),
      passwordUpdated: Boolean(payload.password),
    },
  });

  return c.json({ user: buildPortalUserPayload(user) });
});

profileRoutes.post('/profile/password', zValidator('json', changePasswordSchema), async (c) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) {
    return c.json({ error: csrfError }, 403);
  }

  const auth = c.get('portalAuth');
  const { currentPassword, newPassword } = c.req.valid('json');

  const [user] = await db
    .select({
      id: portalUsers.id,
      passwordHash: portalUsers.passwordHash,
      email: portalUsers.email,
      orgId: portalUsers.orgId,
      name: portalUsers.name
    })
    .from(portalUsers)
    .where(eq(portalUsers.id, auth.user.id))
    .limit(1);

  if (!user || !user.passwordHash) {
    return c.json({ error: 'Password authentication is not available for this account' }, 400);
  }

  const validCurrentPassword = await verifyPassword(user.passwordHash, currentPassword);
  if (!validCurrentPassword) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const passwordCheck = isPasswordStrong(newPassword);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  await db
    .update(portalUsers)
    .set({
      passwordHash: await hashPassword(newPassword),
      updatedAt: new Date()
    })
    .where(eq(portalUsers.id, auth.user.id));

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      const indexKey = PORTAL_REDIS_KEYS.userSessions(auth.user.id);
      const tokens = await redis.smembers(indexKey);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => PORTAL_REDIS_KEYS.session(t)));
      }
      await redis.del(indexKey);
    }
  }

  for (const [sessionToken, session] of portalSessions.entries()) {
    if (session.portalUserId === auth.user.id) {
      portalSessions.delete(sessionToken);
    }
  }

  writePortalAudit(c, {
    orgId: auth.user.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'portal.profile.password.change',
    resourceType: 'portal_user',
    resourceId: auth.user.id,
    resourceName: user.name ?? user.email
  });

  return c.json({ success: true, message: 'Password changed successfully' });
});
