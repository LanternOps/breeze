import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalUsers } from '../../db/schema';
import { hashPassword, isPasswordStrong, verifyPassword } from '../../services/password';
import { getRedis } from '../../services/redis';
import { rejectProof, INVALID_CREDENTIALS_CODE } from '../auth/helpers';
import {
  updateProfileSchema,
  changePasswordSchema,
  PORTAL_USE_REDIS,
  PORTAL_REDIS_KEYS,
  PASSWORD_CHANGE_RATE_LIMIT,
} from './schemas';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  portalSessions,
  buildPortalUserPayload,
  checkRateLimit,
  isEtagFresh,
  validatePortalCookieCsrfRequest,
  writePortalAudit,
} from './helpers';

export const profileRoutes = new Hono();

profileRoutes.get('/profile', async (c) => {
  const auth = c.get('portalAuth');
  const payload = { user: buildPortalUserPayload(auth.user) };

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 15,
    staleWhileRevalidateSeconds: 60,
    vary: ['Authorization', 'Cookie']
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
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

  // #4797: throttle current-password guesses BEFORE looking the account up or
  // verifying anything, keyed on the portal user id alone — this route is
  // already session-authed (portalAuthMiddleware), so unlike the anonymous
  // login/reset limiters there is no IP axis to also key on. Without this a
  // stolen portal session could brute-force the current password at one
  // argon2 verify per request with no lockout (the #4746 class). Uses the
  // portal's own dual-mode limiter so self-hosted deployments without Redis
  // keep working, exactly like every other portal auth rate limit.
  const rateKey = `portal:profile-password:${auth.user.id}`;
  const rate = await checkRateLimit(rateKey, PASSWORD_CHANGE_RATE_LIMIT);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
  }

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
    // #4797 (follows #4470/#4651/#4660): `currentPassword` is body data this
    // handler validates, not the credential authenticating the request (the
    // portal session cookie/bearer, already checked by portalAuthMiddleware).
    // A 401 here collided with the session guard and the portal client
    // (apps/portal/src/lib/api.ts) funnelled it into clearAuth() + a redirect
    // to /login — a mistyped current password signed the user out mid-flow.
    // 400 + a stable code matches the neighbouring rejections on this same
    // route (passwordless account above, weak new password below), which
    // were already 400.
    return rejectProof(c, 'Current password is incorrect', INVALID_CREDENTIALS_CODE, 400);
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
