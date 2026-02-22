import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { db } from '../../db';
import { portalUsers } from '../../db/schema';
import { hashPassword, isPasswordStrong, verifyPassword } from '../../services/password';
import { getEmailService } from '../../services/email';
import { getRedis } from '../../services/redis';
import {
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  RESET_TTL_MS,
  RESET_TTL_SECONDS,
  PORTAL_SESSION_CAP,
  PORTAL_RESET_TOKEN_CAP,
  PORTAL_SESSION_COOKIE_NAME,
  PORTAL_USE_REDIS,
  PORTAL_REDIS_KEYS,
  LOGIN_RATE_LIMIT,
  FORGOT_PASSWORD_RATE_LIMIT,
  RESET_PASSWORD_RATE_LIMIT,
} from './schemas';
import {
  portalSessions,
  portalResetTokens,
  normalizeEmail,
  getClientIp,
  setPortalSessionCookies,
  clearPortalSessionCookies,
  getCookieValue,
  capMapByOldest,
  sweepPortalState,
  checkRateLimit,
  clearRateLimitKeys,
  buildPortalUserPayload,
  validatePortalCookieCsrfRequest,
} from './helpers';

export const authRoutes = new Hono();
const ALLOW_IN_MEMORY_PORTAL_STATE = !PORTAL_USE_REDIS;

// ============================================
// Auth middleware
// ============================================

export async function portalAuthMiddleware(c: Context, next: Next) {
  sweepPortalState();

  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = getCookieValue(c.req.header('cookie'), PORTAL_SESSION_COOKIE_NAME);
  const token = bearerToken || cookieToken;
  const authMethod = bearerToken ? 'bearer' : 'cookie';

  if (!token) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  let sessionData: { portalUserId: string; orgId: string } | null = null;

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      if (process.env.NODE_ENV === 'production') {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
    } else {
      const raw = await redis.get(PORTAL_REDIS_KEYS.session(token));
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          sessionData = { portalUserId: parsed.portalUserId, orgId: parsed.orgId };
        } catch (err) {
          console.error('[portal] Failed to parse Redis session data:', (err as Error).message);
        }
      }
    }
  }

  if (!sessionData && ALLOW_IN_MEMORY_PORTAL_STATE) {
    const session = portalSessions.get(token);
    if (session && session.expiresAt.getTime() > Date.now()) {
      sessionData = { portalUserId: session.portalUserId, orgId: session.orgId };
    } else if (session) {
      portalSessions.delete(token);
    }
  }

  if (!sessionData) {
    if (cookieToken) {
      clearPortalSessionCookies(c);
    }
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  const [user] = await db
    .select({
      id: portalUsers.id,
      orgId: portalUsers.orgId,
      email: portalUsers.email,
      name: portalUsers.name,
      receiveNotifications: portalUsers.receiveNotifications,
      status: portalUsers.status
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, sessionData.portalUserId), eq(portalUsers.orgId, sessionData.orgId)))
    .limit(1);

  if (!user) {
    if (PORTAL_USE_REDIS) {
      const redis = getRedis();
      if (redis) await redis.del(PORTAL_REDIS_KEYS.session(token));
    }
    if (ALLOW_IN_MEMORY_PORTAL_STATE) {
      portalSessions.delete(token);
    }
    if (cookieToken) {
      clearPortalSessionCookies(c);
    }
    return c.json({ error: 'Portal user not found' }, 401);
  }

  if (user.status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  // Sliding session timeout: any authenticated activity pushes expiry forward.
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      try {
        await redis
          .multi()
          .expire(PORTAL_REDIS_KEYS.session(token), SESSION_TTL_SECONDS)
          .expire(PORTAL_REDIS_KEYS.userSessions(user.id), SESSION_TTL_SECONDS * 2)
          .exec();
      } catch (error) {
        console.error('[portal] Failed to extend Redis session TTL:', error);
      }
    }
  }

  if (ALLOW_IN_MEMORY_PORTAL_STATE) {
    const session = portalSessions.get(token);
    if (session) {
      session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      portalSessions.set(token, session);
    }
  }

  if (authMethod === 'cookie') {
    setPortalSessionCookies(c, token);
  }

  c.set('portalAuth', { user, token, authMethod });
  return next();
}

// ============================================
// Auth routes
// ============================================

authRoutes.post('/auth/login', zValidator('json', loginSchema), async (c) => {
  sweepPortalState();

  const { email, password, orgId } = c.req.valid('json');
  const normalizedEmail = normalizeEmail(email);
  const clientIp = getClientIp(c);
  const ipRateKey = `portal:login:ip:${clientIp}`;
  const accountRateKey = `portal:login:account:${orgId ?? 'any'}:${normalizedEmail}`;

  for (const rateKey of [ipRateKey, accountRateKey]) {
    const rate = await checkRateLimit(rateKey, LOGIN_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many login attempts. Please try again later.' }, 429);
    }
  }

  const userRows = await db
    .select({
      id: portalUsers.id,
      orgId: portalUsers.orgId,
      email: portalUsers.email,
      name: portalUsers.name,
      passwordHash: portalUsers.passwordHash,
      receiveNotifications: portalUsers.receiveNotifications,
      status: portalUsers.status
    })
    .from(portalUsers)
    .where(
      orgId
        ? and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, normalizedEmail))
        : eq(portalUsers.email, normalizedEmail)
    )
    .limit(orgId ? 1 : 2);

  if (!orgId && userRows.length > 1) {
    return c.json({ error: 'Multiple portal accounts found for this email. Please provide organization context.' }, 400);
  }

  const user = userRows[0];

  if (!user || !user.passwordHash) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const validPassword = await verifyPassword(user.passwordHash, password);
  if (!validPassword) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  if (user.status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  const now = new Date();
  const token = nanoid(48);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      if (!ALLOW_IN_MEMORY_PORTAL_STATE) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
    } else {
      const sessionPayload = JSON.stringify({
        portalUserId: user.id,
        orgId: user.orgId,
        createdAt: now.toISOString(),
      });
      const results = await redis
        .multi()
        .setex(PORTAL_REDIS_KEYS.session(token), SESSION_TTL_SECONDS, sessionPayload)
        .sadd(PORTAL_REDIS_KEYS.userSessions(user.id), token)
        .expire(PORTAL_REDIS_KEYS.userSessions(user.id), SESSION_TTL_SECONDS * 2)
        .exec();
      if (results) {
        const pipelineErrors = results.filter(([err]) => err);
        if (pipelineErrors.length > 0) {
          for (const [err] of pipelineErrors) {
            console.error('[portal] Redis session pipeline error:', err!.message);
          }
          if (process.env.NODE_ENV === 'production') {
            return c.json({ error: 'Service temporarily unavailable' }, 503);
          }
        }
      }
    }
  }

  if (ALLOW_IN_MEMORY_PORTAL_STATE) {
    portalSessions.set(token, {
      token,
      portalUserId: user.id,
      orgId: user.orgId,
      createdAt: now,
      expiresAt
    });
    capMapByOldest(portalSessions, PORTAL_SESSION_CAP, (session) => session.createdAt.getTime());
  }

  await db
    .update(portalUsers)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(portalUsers.id, user.id));

  const resolvedAccountRateKey = `portal:login:account:${user.orgId}:${normalizedEmail}`;
  await clearRateLimitKeys([ipRateKey, accountRateKey, resolvedAccountRateKey]);

  setPortalSessionCookies(c, token);

  return c.json({
    user: buildPortalUserPayload(user),
    accessToken: token,
    expiresAt,
    tokens: {
      accessToken: token,
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000)
    }
  });
});

authRoutes.post('/auth/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  sweepPortalState();

  const { email, orgId } = c.req.valid('json');
  const normalizedEmail = normalizeEmail(email);
  const clientIp = getClientIp(c);
  const ipRateKey = `portal:forgot:ip:${clientIp}`;
  const accountRateKey = `portal:forgot:account:${orgId ?? 'any'}:${normalizedEmail}`;

  for (const rateKey of [ipRateKey, accountRateKey]) {
    const rate = await checkRateLimit(rateKey, FORGOT_PASSWORD_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many password reset attempts. Please try again later.' }, 429);
    }
  }

  const redis = PORTAL_USE_REDIS ? getRedis() : null;
  if (PORTAL_USE_REDIS && !redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const [user] = await db
    .select({ id: portalUsers.id, email: portalUsers.email, orgId: portalUsers.orgId })
    .from(portalUsers)
    .where(
      orgId
        ? and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, normalizedEmail))
        : eq(portalUsers.email, normalizedEmail)
    )
    .limit(1);

  if (user) {
    const resetToken = nanoid(48);
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);

    if (PORTAL_USE_REDIS) {
      await redis!.setex(
        PORTAL_REDIS_KEYS.resetToken(tokenHash),
        RESET_TTL_SECONDS,
        JSON.stringify({ userId: user.id })
      );
    }
    if (ALLOW_IN_MEMORY_PORTAL_STATE) {
      portalResetTokens.set(tokenHash, { userId: user.id, expiresAt, createdAt: new Date() });
      capMapByOldest(portalResetTokens, PORTAL_RESET_TOKEN_CAP, (token) => token.createdAt.getTime());
    }

    const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
    const orgQuery = orgId ? `&orgId=${encodeURIComponent(orgId)}` : '';
    const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}${orgQuery}`;
    const emailService = getEmailService();

    if (emailService) {
      try {
        await emailService.sendPasswordReset({
          to: user.email,
          resetUrl
        });
      } catch (error) {
        console.error('[portal] Failed to send password reset email:', error);
      }
    } else {
      console.warn('[PortalAuth] Email service not configured; password reset email was not sent');
    }
  }

  return c.json({ success: true, message: 'If this email exists, a reset link will be sent.' });
});

authRoutes.post('/auth/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  sweepPortalState();

  const { token, password } = c.req.valid('json');
  const clientIp = getClientIp(c);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const ipRateKey = `portal:reset:ip:${clientIp}`;
  const tokenRateKey = `portal:reset:token:${tokenHash}`;

  for (const rateKey of [ipRateKey, tokenRateKey]) {
    const rate = await checkRateLimit(rateKey, RESET_PASSWORD_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many password reset attempts. Please try again later.' }, 429);
    }
  }

  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  let storedUserId: string | null = null;

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      if (!ALLOW_IN_MEMORY_PORTAL_STATE) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
    } else {
      const raw = await redis.get(PORTAL_REDIS_KEYS.resetToken(tokenHash));
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          storedUserId = parsed.userId;
        } catch (err) {
          console.error('[portal] Failed to parse Redis reset token data:', (err as Error).message);
        }
        await redis.del(PORTAL_REDIS_KEYS.resetToken(tokenHash));
      }
    }
  }

  if (!storedUserId && ALLOW_IN_MEMORY_PORTAL_STATE) {
    const stored = portalResetTokens.get(tokenHash);
    if (stored && stored.expiresAt.getTime() > Date.now()) {
      storedUserId = stored.userId;
    }
    portalResetTokens.delete(tokenHash);
  }

  if (!storedUserId) {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  await db
    .update(portalUsers)
    .set({ passwordHash, updatedAt: now })
    .where(eq(portalUsers.id, storedUserId));

  await clearRateLimitKeys([ipRateKey, tokenRateKey]);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      const indexKey = PORTAL_REDIS_KEYS.userSessions(storedUserId);
      const tokens = await redis.smembers(indexKey);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => PORTAL_REDIS_KEYS.session(t)));
      }
      await redis.del(indexKey);
    }
  }

  if (ALLOW_IN_MEMORY_PORTAL_STATE) {
    for (const [sessionToken, session] of portalSessions.entries()) {
      if (session.portalUserId === storedUserId) {
        portalSessions.delete(sessionToken);
      }
    }
  }

  return c.json({ success: true, message: 'Password reset successfully' });
});

authRoutes.post('/auth/logout', portalAuthMiddleware, async (c) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) {
    return c.json({ error: csrfError }, 403);
  }

  const auth = c.get('portalAuth');

  if (ALLOW_IN_MEMORY_PORTAL_STATE) {
    portalSessions.delete(auth.token);
  }
  clearPortalSessionCookies(c);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      console.warn('[portal] Redis unavailable during logout; cannot clear distributed portal session state for user:', auth.user.id);
      return c.json({ success: true });
    }
    await redis.del(PORTAL_REDIS_KEYS.session(auth.token));
    await redis.srem(PORTAL_REDIS_KEYS.userSessions(auth.user.id), auth.token);
  }

  return c.json({ success: true });
});
