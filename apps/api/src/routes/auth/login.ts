import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  createTokenPair,
  verifyToken,
  verifyPassword,
  hashPassword,
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
  getClientRateLimitKey,
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
  auditLogin,
  userRequiresSetup
} from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

// Lazily-computed dummy argon2id hash used to constant-time the
// user-not-found branch of the login handler. The first miss after
// startup computes and caches it; every miss after that reuses the same
// hash. Without this, response timing reveals whether an email exists
// in the users table (hit runs verifyPassword → ~100-500ms argon2; miss
// returns immediately → ~1ms), trivially enabling email enumeration.
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hashPassword('__login-timing-dummy-never-matches__');
  }
  return dummyPasswordHashPromise;
}

export const loginRoutes = new Hono();

// Login
loginRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const ip = getClientIP(c);
  const rateLimitClient = getClientRateLimitKey(c);
  const normalizedEmail = email.toLowerCase();

  // Rate limit by IP + email combination - fail closed for security
  // In E2E mode, skip rate limiting entirely
  const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';
  if (!e2eMode) {
    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    // First, IP-only bucket — guards against credential stuffing where the
    // attacker rotates email each attempt to keep the per-(IP,email) bucket
    // fresh. 30 attempts per 5min per IP is well above any legitimate SSO
    // landing page, but cuts a stuffing run from thousands/min to a trickle.
    const ipRateKey = `login:ip:${ip}`;
    const ipRateCheck = await rateLimiter(redis, ipRateKey, 30, 5 * 60);
    if (!ipRateCheck.allowed) {
      return c.json({
        error: 'Too many login attempts. Please try again later.',
        retryAfter: Math.ceil((ipRateCheck.resetAt.getTime() - Date.now()) / 1000)
      }, 429);
    }

    const rateKey = `login:${rateLimitClient}:${normalizedEmail}`;
    const rateCheck = await rateLimiter(redis, rateKey, loginLimiter.limit, loginLimiter.windowSeconds);

    if (!rateCheck.allowed) {
      return c.json({
        error: 'Too many login attempts. Please try again later.',
        retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
      }, 429);
    }
  }

  // Find user — pre-auth lookup, must run under system scope since no
  // request context has set breeze.scope yet. The `users` table is under
  // RLS; without this wrap the lookup returns empty for real emails under
  // breeze_app, and login would always 401 regardless of password.
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1)
  );

  if (!user || !user.passwordHash) {
    // Constant-time response: run one argon2 verify against a dummy hash
    // so the handler's latency matches the found-user branch. This blunts
    // email enumeration via timing side-channel.
    await verifyPassword(await getDummyPasswordHash(), password).catch(() => false);
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

  // Check account status. Avoid response-content differentiation here: a
  // distinct 403 "Account is not active" lets attackers enumerate which
  // emails are valid + active vs suspended. Return the SAME generic 401
  // used for invalid creds, but keep the rich audit trail (status, reason)
  // so ops can still see why a real user was bounced.
  if (user.status !== 'active') {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'account_inactive',
      result: 'denied',
      details: { accountStatus: user.status, method: 'password' }
    });
    return c.json(genericAuthError(), 401);
  }

  // Check if MFA is required
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms')) {
    // Create a temporary token for MFA verification
    const tempToken = nanoid(32);
    const mfaMethod = user.mfaMethod || 'totp';
    await getRedis()!.setex(`mfa:pending:${tempToken}`, 300, JSON.stringify({
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
  // MFA is vacuously satisfied when the user hasn't enrolled in MFA
  const mfaSatisfied = !(ENABLE_2FA && user.mfaEnabled);
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope,
    mfa: mfaSatisfied
  });

  // Update last login
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  auditLogin(c, { orgId: orgId ?? null, userId: user.id, email: user.email, name: user.name, mfa: false, scope, ip });

  setRefreshTokenCookie(c, tokens.refreshToken);

  const requiresSetup = userRequiresSetup(user);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: ENABLE_2FA ? user.mfaEnabled : false,
      avatarUrl: user.avatarUrl
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false,
    requiresSetup
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

  createAuditLogAsync({
    orgId: auth.orgId ?? undefined,
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

  // Rate limit per user — 10 refreshes per minute
  const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';
  if (!e2eMode) {
    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const refreshRateKey = `refresh:${payload.sub}`;
    const refreshRateCheck = await rateLimiter(redis, refreshRateKey, 10, 60);
    if (!refreshRateCheck.allowed) {
      return c.json({
        error: 'Too many refresh attempts. Please try again later.',
        retryAfter: Math.ceil((refreshRateCheck.resetAt.getTime() - Date.now()) / 1000)
      }, 429);
    }
  }

  if (await isRefreshTokenJtiRevoked(payload.jti)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  if (await isTokenRevokedForUser(payload.sub, payload.iat)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Check if user still exists and is active — pre-auth, wrap in system scope.
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)
  );

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
