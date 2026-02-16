import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  createTokenPair,
  verifyToken,
  verifyPassword,
  rateLimiter,
  loginLimiter,
  getRedis,
  isRefreshTokenJtiRevoked,
  revokeAllUserTokens,
  revokeRefreshTokenJti
} from '../../services';
import { authMiddleware } from '../../middleware/auth';
import { createAuditLogAsync } from '../../services/auditService';
import { nanoid } from 'nanoid';
import { ENABLE_2FA, loginSchema } from './schemas';
import {
  getClientIP,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  resolveRefreshToken,
  validateCookieCsrfRequest,
  toPublicTokens,
  genericAuthError,
  isTokenRevokedForUser,
  revokeCurrentRefreshTokenJti,
  resolveCurrentUserTokenContext,
  auditUserLoginFailure,
  auditLogin
} from './helpers';

const { db } = dbModule;

export const loginRoutes = new Hono();

// Login
loginRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const ip = getClientIP(c);
  const normalizedEmail = email.toLowerCase();

  // Rate limit by IP + email combination - fail closed for security
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const rateKey = `login:${ip}:${normalizedEmail}`;
  const rateCheck = await rateLimiter(redis, rateKey, loginLimiter.limit, loginLimiter.windowSeconds);

  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  // Find user
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (!user || !user.passwordHash) {
    if (user) {
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'password_auth_not_available',
        details: { method: 'password' }
      });
    }
    return c.json(genericAuthError(), 401);
  }

  // Verify password
  const validPassword = await verifyPassword(user.passwordHash, password);
  if (!validPassword) {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'invalid_password',
      details: { method: 'password' }
    });
    return c.json(genericAuthError(), 401);
  }

  // Check account status
  if (user.status !== 'active') {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'account_inactive',
      result: 'denied',
      details: { accountStatus: user.status, method: 'password' }
    });
    return c.json({ error: 'Account is not active' }, 403);
  }

  // Check if MFA is required
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms')) {
    // Create a temporary token for MFA verification
    const tempToken = nanoid(32);
    const mfaMethod = user.mfaMethod || 'totp';
    await redis.setex(`mfa:pending:${tempToken}`, 300, JSON.stringify({
      userId: user.id,
      mfaMethod
    }));

    return c.json({
      mfaRequired: true,
      tempToken,
      mfaMethod,
      phoneLast4: user.phoneNumber?.slice(-4) || null,
      user: null,
      tokens: null
    });
  }

  // Look up user's partner/org context
  const context = await resolveCurrentUserTokenContext(user.id);
  const roleId = context.roleId;
  const partnerId = context.partnerId;
  const orgId = context.orgId;
  const scope = context.scope;

  // Create tokens with user's context
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope,
    mfa: false
  });

  // Update last login
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  if (orgId) {
    auditLogin(c, { orgId, userId: user.id, email: user.email, name: user.name, mfa: false, scope, ip });
  } else {
    console.warn('[audit] Skipping login audit for non-org-scoped user', { userId: user.id, scope });
  }

  setRefreshTokenCookie(c, tokens.refreshToken);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: ENABLE_2FA ? user.mfaEnabled : false,
      avatarUrl: user.avatarUrl
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false
  });
});

// Logout
loginRoutes.post('/logout', authMiddleware, async (c) => {
  const auth = c.get('auth');

  try {
    await revokeAllUserTokens(auth.user.id);
    await revokeCurrentRefreshTokenJti(c, auth.user.id);
  } catch (error) {
    console.error('[auth] Failed to revoke tokens during logout — clearing cookie anyway:', error);
  }

  if (auth.orgId) {
    createAuditLogAsync({
      orgId: auth.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'user.logout',
      resourceType: 'user',
      resourceId: auth.user.id,
      resourceName: auth.user.name,
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'success'
    });
  } else {
    console.warn('[audit] Skipping logout audit for non-org-scoped user', { userId: auth.user.id, scope: auth.scope });
  }

  clearRefreshTokenCookie(c);
  return c.json({ success: true });
});

// Refresh token
loginRoutes.post('/refresh', async (c) => {
  const refreshToken = resolveRefreshToken(c);

  if (!refreshToken) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const csrfError = validateCookieCsrfRequest(c);
  if (csrfError) {
    clearRefreshTokenCookie(c);
    return c.json({ error: csrfError }, 403);
  }

  const payload = await verifyToken(refreshToken);

  if (!payload || payload.type !== 'refresh' || !payload.jti) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  if (await isRefreshTokenJtiRevoked(payload.jti)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  if (await isTokenRevokedForUser(payload.sub, payload.iat)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Check if user still exists and is active
  const [user] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user || user.status !== 'active') {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const context = await resolveCurrentUserTokenContext(user.id);

  // Create new token pair
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: ENABLE_2FA ? payload.mfa : false
  });

  try {
    await revokeRefreshTokenJti(payload.jti);
  } catch (error) {
    console.error('[auth] Failed to revoke old refresh token JTI during rotation:', error);
  }
  setRefreshTokenCookie(c, tokens.refreshToken);
  return c.json({ tokens: toPublicTokens(tokens) });
});
