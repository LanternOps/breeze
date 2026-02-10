import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users, sessions, partners, partnerUsers, roles, organizationUsers, organizations } from '../db/schema';
import {
  hashPassword,
  verifyPassword,
  isPasswordStrong,
  createTokenPair,
  verifyToken,
  generateMFASecret,
  verifyMFAToken,
  generateOTPAuthURL,
  generateQRCode,
  generateRecoveryCodes,
  createSession,
  invalidateSession,
  invalidateAllUserSessions,
  rateLimiter,
  loginLimiter,
  forgotPasswordLimiter,
  mfaLimiter,
  getRedis,
  smsPhoneVerifyLimiter,
  smsPhoneVerifyUserLimiter,
  smsLoginSendLimiter,
  smsLoginGlobalLimiter,
  phoneConfirmLimiter,
  isUserTokenRevoked,
  revokeAllUserTokens,
  isRefreshTokenJtiRevoked,
  revokeRefreshTokenJti,
  getTrustedClientIp
} from '../services';
import { getTwilioService } from '../services/twilio';
import { getEmailService } from '../services/email';
import { authMiddleware } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';
import type { RequestLike } from '../services/auditEvents';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { decryptSecret, encryptSecret } from '../services/secretCrypto';
import { DEFAULT_ALLOWED_ORIGINS } from '../services/corsOrigins';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

export const authRoutes = new Hono();

// ============================================
// Schemas
// ============================================

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255)
});

const registerPartnerSchema = z.object({
  companyName: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255),
  acceptTerms: z.boolean().refine(val => val === true, {
    message: 'You must accept the terms of service'
  })
});

const mfaVerifySchema = z.object({
  code: z.string().length(6),
  tempToken: z.string().optional(),
  method: z.enum(['totp', 'sms']).optional()
});

const phoneVerifySchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Invalid phone number. Use E.164 format (e.g. +14155551234)')
});

const phoneConfirmSchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  code: z.string().length(6)
});

const smsSendSchema = z.object({
  tempToken: z.string()
});

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

const mfaEnableSchema = z.object({
  code: z.string().length(6)
});

// ============================================
// Helpers
// ============================================

function getClientIP(c: RequestLike): string {
  return getTrustedClientIp(c);
}

const REFRESH_COOKIE_NAME = 'breeze_refresh_token';
const REFRESH_COOKIE_PATH = '/api/v1/auth';
const REFRESH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CSRF_HEADER_NAME = 'x-breeze-csrf';

function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

function buildRefreshTokenCookie(refreshToken: string): string {
  const secure = isSecureCookieEnvironment() ? '; Secure' : '';
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}; Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}${secure}`;
}

function buildClearRefreshTokenCookie(): string {
  const secure = isSecureCookieEnvironment() ? '; Secure' : '';
  return `${REFRESH_COOKIE_NAME}=; Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function setRefreshTokenCookie(c: Context, refreshToken: string): void {
  c.header('Set-Cookie', buildRefreshTokenCookie(refreshToken), { append: true });
}

function clearRefreshTokenCookie(c: Context): void {
  c.header('Set-Cookie', buildClearRefreshTokenCookie(), { append: true });
}

function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const target = `${name}=`;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

function resolveRefreshToken(c: Context): string | null {
  return getCookieValue(c.req.header('cookie'), REFRESH_COOKIE_NAME);
}

function getAllowedOrigins(): Set<string> {
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return new Set<string>([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins]);
}

function isAllowedOrigin(origin: string): boolean {
  const allowList = getAllowedOrigins();
  if (allowList.has(origin)) {
    return true;
  }

  if (process.env.NODE_ENV !== 'production') {
    try {
      const parsed = new URL(origin);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function validateCookieCsrfRequest(c: Context): string | null {
  const csrfHeader = c.req.header(CSRF_HEADER_NAME);
  if (!csrfHeader || csrfHeader.trim().length === 0) {
    return 'Missing CSRF header';
  }

  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin)) {
    return 'Invalid request origin';
  }

  return null;
}

type PublicTokenPayload = {
  accessToken: string;
  expiresInSeconds: number;
};

function toPublicTokens(tokens: { accessToken: string; expiresInSeconds: number }): PublicTokenPayload {
  return {
    accessToken: tokens.accessToken,
    expiresInSeconds: tokens.expiresInSeconds
  };
}

function encryptMfaSecret(secret: string | null | undefined): string | null {
  return encryptSecret(secret);
}

function decryptMfaSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  try {
    return decryptSecret(secret);
  } catch (error) {
    console.error('[auth] Failed to decrypt MFA secret — user may need to re-enroll MFA:', error);
    return null;
  }
}

function getRecoveryCodePepper(): string {
  const pepper =
    process.env.MFA_RECOVERY_CODE_PEPPER
    || process.env.APP_ENCRYPTION_KEY
    || process.env.SECRET_ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || (process.env.NODE_ENV === 'test' ? 'test-mfa-recovery-code-pepper' : '');

  if (!pepper && process.env.NODE_ENV === 'production') {
    throw new Error('No MFA recovery code pepper configured. Set MFA_RECOVERY_CODE_PEPPER, APP_ENCRYPTION_KEY, SECRET_ENCRYPTION_KEY, or JWT_SECRET.');
  }

  return pepper;
}

function hashRecoveryCode(code: string): string {
  const normalizedCode = code.trim().toUpperCase();
  return createHash('sha256')
    .update(`${getRecoveryCodePepper()}:${normalizedCode}`)
    .digest('hex');
}

function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map(hashRecoveryCode);
}

function genericAuthError() {
  return { error: 'Invalid email or password' };
}

type UserTokenContext = {
  roleId: string | null;
  partnerId: string | null;
  orgId: string | null;
  scope: 'system' | 'partner' | 'organization';
};

async function isTokenRevokedForUser(userId: string, tokenIssuedAt?: number): Promise<boolean> {
  return isUserTokenRevoked(userId, tokenIssuedAt);
}

async function revokeCurrentRefreshTokenJti(c: Context, expectedUserId?: string): Promise<void> {
  const refreshToken = resolveRefreshToken(c);
  if (!refreshToken) {
    return;
  }

  const payload = await verifyToken(refreshToken);
  if (!payload || payload.type !== 'refresh' || !payload.jti) {
    return;
  }

  if (expectedUserId && payload.sub !== expectedUserId) {
    return;
  }

  await revokeRefreshTokenJti(payload.jti);
}

async function resolveCurrentUserTokenContext(userId: string): Promise<UserTokenContext> {
  return runWithSystemDbAccess(async () => {
    let roleId: string | null = null;
    let partnerId: string | null = null;
    let orgId: string | null = null;
    let scope: 'system' | 'partner' | 'organization' = 'system';

    let partnerUsersTable:
      | { partnerId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      partnerUsersTable = partnerUsers as unknown as { partnerId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      partnerUsersTable = undefined;
    }

    if (partnerUsersTable?.partnerId && partnerUsersTable?.roleId && partnerUsersTable?.userId) {
      const [partnerAssoc] = await db
        .select({
          partnerId: partnerUsers.partnerId,
          roleId: partnerUsers.roleId
        })
        .from(partnerUsers)
        .where(eq(partnerUsers.userId, userId))
        .limit(1);

      if (partnerAssoc?.partnerId && partnerAssoc?.roleId) {
        return {
          roleId: partnerAssoc.roleId,
          partnerId: partnerAssoc.partnerId,
          orgId: null,
          scope: 'partner'
        };
      }
    }

    let organizationUsersTable:
      | { orgId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      organizationUsersTable = organizationUsers as unknown as { orgId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      organizationUsersTable = undefined;
    }

    if (organizationUsersTable?.orgId && organizationUsersTable?.roleId && organizationUsersTable?.userId) {
      const [orgAssoc] = await db
        .select({
          orgId: organizationUsers.orgId,
          roleId: organizationUsers.roleId
        })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, userId))
        .limit(1);

      if (orgAssoc?.orgId && orgAssoc?.roleId) {
        orgId = orgAssoc.orgId;
        roleId = orgAssoc.roleId;
        scope = 'organization';

        const [org] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, orgAssoc.orgId))
          .limit(1);

        partnerId = org?.partnerId ?? null;
      }
    }

    return { roleId, partnerId, orgId, scope };
  });
}

const ANONYMOUS_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

async function resolveUserAuditOrgId(userId: string): Promise<string | null> {
  return runWithSystemDbAccess(async () => {
    try {
      const orgUsersTable = organizationUsers as unknown as { orgId?: unknown; userId?: unknown } | undefined;
      if (!orgUsersTable?.orgId || !orgUsersTable?.userId) {
        return null;
      }

      const [orgAssoc] = await db
        .select({ orgId: organizationUsers.orgId })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, userId))
        .limit(1);

      return orgAssoc?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId for user:', userId, err);
      return null;
    }
  });
}

function writeAuthAudit(
  c: RequestLike,
  opts: {
    orgId: string;
    action: string;
    result: 'success' | 'failure' | 'denied';
    reason?: string;
    userId?: string;
    email?: string;
    name?: string;
    details?: Record<string, unknown>;
  }
): void {
  createAuditLogAsync({
    orgId: opts.orgId,
    actorType: opts.userId ? 'user' : 'system',
    actorId: opts.userId ?? ANONYMOUS_ACTOR_ID,
    actorEmail: opts.email,
    action: opts.action,
    resourceType: 'user',
    resourceId: opts.userId,
    resourceName: opts.name,
    details: {
      ...opts.details,
      reason: opts.reason
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: opts.result
  });
}

async function auditUserLoginFailure(
  c: RequestLike,
  opts: {
    userId: string;
    email?: string;
    name?: string;
    reason: string;
    result?: 'failure' | 'denied';
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const orgId = await resolveUserAuditOrgId(opts.userId);
  if (!orgId) {
    return;
  }

  writeAuthAudit(c, {
    orgId,
    action: 'user.login.failed',
    result: opts.result ?? 'failure',
    reason: opts.reason,
    userId: opts.userId,
    email: opts.email,
    name: opts.name,
    details: opts.details
  });
}

function auditLogin(
  c: RequestLike,
  opts: { orgId: string; userId: string; email: string; name: string; mfa: boolean; scope: string; ip: string }
): void {
  createAuditLogAsync({
    orgId: opts.orgId,
    actorId: opts.userId,
    actorEmail: opts.email,
    action: 'user.login',
    resourceType: 'user',
    resourceId: opts.userId,
    resourceName: opts.name,
    details: { method: 'password', mfa: opts.mfa, scope: opts.scope },
    ipAddress: opts.ip,
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });
}

// ============================================
// Routes
// ============================================

// Register user (compatibility for legacy signup path)
authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password, name } = c.req.valid('json');
  const ip = getClientIP(c);
  const normalizedEmail = email.toLowerCase();

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(redis, `register:${ip}`, 5, 3600);
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many registration attempts. Try again later.' }, 429);
  }

  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  const existingUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existingUsers.length > 0) {
    // Security: use a generic success response to prevent email enumeration.
    return c.json({
      success: true,
      message: 'If registration can proceed, you will receive next steps shortly.'
    });
  }

  const passwordHash = await hashPassword(password);
  const [newUser] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      name,
      passwordHash,
      status: 'active'
    })
    .returning();

  if (!newUser) {
    return c.json({ error: 'Failed to create account' }, 500);
  }

  const context = await resolveCurrentUserTokenContext(newUser.id);
  const tokens = await createTokenPair({
    sub: newUser.id,
    email: newUser.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope
  });

  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, newUser.id));

  setRefreshTokenCookie(c, tokens.refreshToken);

  return c.json({
    user: {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      mfaEnabled: false
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false
  });
});

// Register Partner (self-service MSP/company signup)
authRoutes.post('/register-partner', zValidator('json', registerPartnerSchema), async (c) => {
  const { companyName, email, password, name, acceptTerms } = c.req.valid('json');
  const ip = getClientIP(c);

  return runWithSystemDbAccess(async () => {

    // Rate limit registration - stricter for partner registration
    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const rateCheck = await rateLimiter(redis, `register-partner:${ip}`, 3, 3600);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many registration attempts. Try again later.' }, 429);
    }

    // Validate password strength
    const passwordCheck = isPasswordStrong(password);
    if (!passwordCheck.valid) {
      return c.json({ error: passwordCheck.errors[0] }, 400);
    }

    // Check if user exists
    const existingUser = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existingUser.length > 0) {
      return c.json({ success: true, message: 'If registration can proceed, you will receive next steps shortly.' });
    }

    // Generate slug from company name
    const baseSlug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    // Check if slug exists and make unique if needed
    let slug = baseSlug;
    let suffix = 1;
    while (true) {
      const existingPartner = await db
        .select({ id: partners.id })
        .from(partners)
        .where(eq(partners.slug, slug))
        .limit(1);

      if (existingPartner.length === 0) break;
      slug = `${baseSlug}-${suffix}`;
      suffix++;
      if (suffix > 100) {
        return c.json({ error: 'Unable to generate unique company identifier' }, 500);
      }
    }

    // Start transaction - create partner, role, user, and association
    try {
      // Create partner
      const [newPartner] = await db
        .insert(partners)
        .values({
          name: companyName,
          slug,
          type: 'msp',
          plan: 'free'
        })
        .returning();

      if (!newPartner) {
        return c.json({ error: 'Failed to create company' }, 500);
      }

      // Create Partner Admin role for this partner
      const [adminRole] = await db
        .insert(roles)
        .values({
          partnerId: newPartner.id,
          scope: 'partner',
          name: 'Partner Admin',
          description: 'Full access to partner and all organizations',
          isSystem: true
        })
        .returning();

      if (!adminRole) {
        // Cleanup partner
        await db.delete(partners).where(eq(partners.id, newPartner.id));
        return c.json({ error: 'Failed to create admin role' }, 500);
      }

      // Create user
      const passwordHash = await hashPassword(password);
      const [newUser] = await db
        .insert(users)
        .values({
          email: email.toLowerCase(),
          name,
          passwordHash,
          status: 'active'
        })
        .returning();

      if (!newUser) {
        // Cleanup
        await db.delete(roles).where(eq(roles.id, adminRole.id));
        await db.delete(partners).where(eq(partners.id, newPartner.id));
        return c.json({ error: 'Failed to create user' }, 500);
      }

      // Associate user with partner
      await db.insert(partnerUsers).values({
        partnerId: newPartner.id,
        userId: newUser.id,
        roleId: adminRole.id,
        orgAccess: 'all'
      });

      // Create tokens with partner scope
      const tokens = await createTokenPair({
        sub: newUser.id,
        email: newUser.email,
        roleId: adminRole.id,
        orgId: null,
        partnerId: newPartner.id,
        scope: 'partner'
      });

      // Update last login
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, newUser.id));

      setRefreshTokenCookie(c, tokens.refreshToken);

      return c.json({
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          mfaEnabled: false
        },
        partner: {
          id: newPartner.id,
          name: newPartner.name,
          slug: newPartner.slug
        },
        tokens: toPublicTokens(tokens),
        mfaRequired: false
      });
    } catch (err) {
      console.error('Partner registration error:', err);
      return c.json({ error: 'Registration failed. Please try again.' }, 500);
    }
  });
});

// Login
authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
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
  if (user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms')) {
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
    scope
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
      mfaEnabled: user.mfaEnabled,
      avatarUrl: user.avatarUrl
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false
  });
});

// Logout
authRoutes.post('/logout', authMiddleware, async (c) => {
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
authRoutes.post('/refresh', async (c) => {
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
    scope: context.scope
  });

  try {
    await revokeRefreshTokenJti(payload.jti);
  } catch (error) {
    console.error('[auth] Failed to revoke old refresh token JTI during rotation:', error);
  }
  setRefreshTokenCookie(c, tokens.refreshToken);
  return c.json({ tokens: toPublicTokens(tokens) });
});

// MFA setup (requires auth)
authRoutes.post('/mfa/setup', authMiddleware, async (c) => {
  const auth = c.get('auth');

  // Check if MFA is already enabled
  const [user] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (user?.mfaEnabled) {
    return c.json({ error: 'MFA is already enabled' }, 400);
  }

  // Generate new secret
  const secret = generateMFASecret();
  const otpAuthUrl = generateOTPAuthURL(secret, auth.user.email);
  const qrCodeDataUrl = await generateQRCode(otpAuthUrl);
  const recoveryCodes = generateRecoveryCodes();

  // Store secret temporarily (not enabled yet until verified)
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'MFA setup unavailable. Please try again later.' }, 503);
  }
  await redis.setex(
    `mfa:setup:${auth.user.id}`,
    600, // 10 min expiry
    JSON.stringify({ secret, recoveryCodes })
  );

  return c.json({
    secret,
    otpAuthUrl,
    qrCodeDataUrl,
    recoveryCodes
  });
});

// MFA verify (for login or setup confirmation)
authRoutes.post('/mfa/verify', zValidator('json', mfaVerifySchema), async (c) => {
  const { code, tempToken, method: requestMethod } = c.req.valid('json');
  const redis = getRedis();

  if (!redis) {
    return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  }

  // Case 1: Verifying during login (has tempToken)
  if (tempToken) {
    const pendingRaw = await redis.get(`mfa:pending:${tempToken}`);
    if (!pendingRaw) {
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }

    // Parse pending data — supports both legacy (plain userId string) and new (JSON) format
    let pendingUserId: string;
    let pendingMfaMethod: string;
    try {
      const parsed = JSON.parse(pendingRaw);
      pendingUserId = parsed.userId;
      pendingMfaMethod = parsed.mfaMethod || 'totp';
    } catch {
      // Legacy format: plain userId string
      pendingUserId = pendingRaw;
      pendingMfaMethod = 'totp';
    }

    // Rate limit MFA attempts
    const rateCheck = await rateLimiter(redis, `mfa:${pendingUserId}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many MFA attempts' }, 429);
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, pendingUserId))
      .limit(1);

    if (!user) {
      return c.json({ error: 'Invalid MFA configuration' }, 400);
    }

    // Use the server-stored method only — never allow the client to override
    const effectiveMethod = pendingMfaMethod;

    let valid = false;
    if (effectiveMethod === 'sms') {
      const phone = user.phoneNumber;
      if (!phone) {
        return c.json({ error: 'No phone number configured for SMS MFA' }, 400);
      }
      const twilio = getTwilioService();
      if (!twilio) {
        return c.json({ error: 'SMS service not configured' }, 501);
      }
      const result = await twilio.checkVerificationCode(phone, code);
      if (result.serviceError) {
        return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
      }
      valid = result.valid;
    } else {
      // TOTP verification
      const decryptedMfaSecret = decryptMfaSecret(user.mfaSecret);
      if (!decryptedMfaSecret) {
        return c.json({ error: 'Invalid MFA configuration' }, 400);
      }
      valid = await verifyMFAToken(decryptedMfaSecret, code);
    }

    if (!valid) {
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'mfa_invalid_code',
        details: { method: effectiveMethod }
      });
      return c.json({ error: 'Invalid MFA code' }, 401);
    }

    // Clear temp token
    await redis.del(`mfa:pending:${tempToken}`);

    // Look up user's partner/org context
    const mfaContext = await resolveCurrentUserTokenContext(user.id);
    const mfaRoleId = mfaContext.roleId;
    const mfaPartnerId = mfaContext.partnerId;
    const mfaOrgId = mfaContext.orgId;
    const mfaScope = mfaContext.scope;

    // Create tokens with user's context
    const tokens = await createTokenPair({
      sub: user.id,
      email: user.email,
      roleId: mfaRoleId,
      orgId: mfaOrgId,
      partnerId: mfaPartnerId,
      scope: mfaScope
    });

    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    if (mfaOrgId) {
      auditLogin(c, { orgId: mfaOrgId, userId: user.id, email: user.email, name: user.name, mfa: true, scope: mfaScope, ip: getClientIP(c) });
    } else {
      console.warn('[audit] Skipping MFA login audit for non-org-scoped user', { userId: user.id, scope: mfaScope });
    }

    setRefreshTokenCookie(c, tokens.refreshToken);

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: true
      },
      tokens: toPublicTokens(tokens),
      mfaRequired: false
    });
  }

  // Case 2: Confirming MFA setup (requires auth)
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);
  if (!payload) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  if (await isTokenRevokedForUser(payload.sub, payload.iat)) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  const setupData = await redis.get(`mfa:setup:${payload.sub}`);
  if (!setupData) {
    return c.json({ error: 'No pending MFA setup' }, 400);
  }

  let secret: string;
  let recoveryCodes: string[];
  try {
    const parsed = JSON.parse(setupData);
    secret = parsed.secret;
    recoveryCodes = parsed.recoveryCodes;
  } catch {
    return c.json({ error: 'Invalid MFA setup data' }, 500);
  }
  const valid = await verifyMFAToken(secret, code);

  if (!valid) {
    const orgId = await resolveUserAuditOrgId(payload.sub);
    if (orgId) {
      writeAuthAudit(c, {
        orgId,
        action: 'auth.mfa.setup.failed',
        result: 'failure',
        reason: 'invalid_mfa_code',
        userId: payload.sub,
        details: { phase: 'setup_confirmation' }
      });
    }
    return c.json({ error: 'Invalid MFA code' }, 401);
  }

  // Enable MFA (TOTP)
  await db
    .update(users)
    .set({
      mfaSecret: encryptMfaSecret(secret),
      mfaEnabled: true,
      mfaMethod: 'totp',
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, payload.sub));

  const setupOrgId = await resolveUserAuditOrgId(payload.sub);
  if (setupOrgId) {
    writeAuthAudit(c, {
      orgId: setupOrgId,
      action: 'auth.mfa.setup',
      result: 'success',
      userId: payload.sub,
      details: { method: 'totp' }
    });
  }

  // Clear setup data
  await redis.del(`mfa:setup:${payload.sub}`);

  return c.json({ success: true, message: 'MFA enabled successfully' });
});

// MFA disable (requires auth + current MFA code)
authRoutes.post('/mfa/disable', authMiddleware, zValidator('json', mfaVerifySchema), async (c) => {
  const auth = c.get('auth');
  const { code } = c.req.valid('json');

  // Check org policy — if requireMfa is true, block disable
  if (auth.orgId) {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, auth.orgId))
      .limit(1);

    const orgSettings = org?.settings as { security?: { requireMfa?: boolean } } | null;
    if (orgSettings?.security?.requireMfa) {
      return c.json({ error: 'Your organization requires MFA. Contact your admin to change this policy.' }, 403);
    }
  }

  const [user] = await db
    .select({
      mfaSecret: users.mfaSecret,
      mfaEnabled: users.mfaEnabled,
      mfaMethod: users.mfaMethod,
      phoneNumber: users.phoneNumber
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user?.mfaEnabled) {
    return c.json({ error: 'MFA is not enabled' }, 400);
  }

  const currentMethod = user.mfaMethod || 'totp';

  // Verify using the appropriate method
  if (currentMethod === 'sms') {
    // For SMS MFA disable, we require a fresh SMS code
    const twilio = getTwilioService();
    if (!twilio) {
      return c.json({ error: 'SMS service not configured' }, 501);
    }

    if (!user.phoneNumber) {
      return c.json({ error: 'No phone number configured' }, 400);
    }
    const result = await twilio.checkVerificationCode(user.phoneNumber, code);
    if (result.serviceError) {
      return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
    }
    if (!result.valid) {
      if (auth.orgId) {
        writeAuthAudit(c, {
          orgId: auth.orgId,
          action: 'auth.mfa.disable.failed',
          result: 'failure',
          reason: 'invalid_sms_code',
          userId: auth.user.id,
          email: auth.user.email,
          details: { method: 'sms' }
        });
      }
      return c.json({ error: 'Invalid verification code' }, 401);
    }
  } else {
    // TOTP
    const decryptedMfaSecret = decryptMfaSecret(user.mfaSecret);
    if (!decryptedMfaSecret) {
      return c.json({ error: 'Invalid MFA configuration' }, 400);
    }
    const valid = await verifyMFAToken(decryptedMfaSecret, code);
    if (!valid) {
      if (auth.orgId) {
        writeAuthAudit(c, {
          orgId: auth.orgId,
          action: 'auth.mfa.disable.failed',
          result: 'failure',
          reason: 'invalid_mfa_code',
          userId: auth.user.id,
          email: auth.user.email,
          details: { method: 'totp' }
        });
      }
      return c.json({ error: 'Invalid MFA code' }, 401);
    }
  }

  await db
    .update(users)
    .set({
      mfaSecret: null,
      mfaEnabled: false,
      mfaMethod: null,
      mfaRecoveryCodes: null,
      phoneNumber: null,
      phoneVerified: false,
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  if (auth.orgId) {
    writeAuthAudit(c, {
      orgId: auth.orgId,
      action: 'auth.mfa.disable',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: currentMethod }
    });
  }

  return c.json({ success: true, message: 'MFA disabled successfully' });
});

// Phone verification - send code (authenticated)
authRoutes.post('/phone/verify', authMiddleware, zValidator('json', phoneVerifySchema), async (c) => {
  const auth = c.get('auth');
  const { phoneNumber } = c.req.valid('json');

  const twilio = getTwilioService();
  if (!twilio) {
    return c.json({ error: 'SMS service not configured' }, 501);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Rate limit per phone number
  const phoneRate = await rateLimiter(
    redis,
    `sms:phone-verify:${phoneNumber}`,
    smsPhoneVerifyLimiter.limit,
    smsPhoneVerifyLimiter.windowSeconds
  );
  if (!phoneRate.allowed) {
    return c.json({ error: 'Too many verification attempts for this number. Try again later.' }, 429);
  }

  // Rate limit per user
  const userRate = await rateLimiter(
    redis,
    `sms:phone-verify-user:${auth.user.id}`,
    smsPhoneVerifyUserLimiter.limit,
    smsPhoneVerifyUserLimiter.windowSeconds
  );
  if (!userRate.allowed) {
    return c.json({ error: 'Too many verification attempts. Try again later.' }, 429);
  }

  const result = await twilio.sendVerificationCode(phoneNumber);
  if (!result.success) {
    if (result.isUserError) {
      return c.json({ error: 'Invalid phone number. Please use a mobile phone number in E.164 format.' }, 400);
    }
    return c.json({ error: 'Failed to send verification code' }, 500);
  }

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.phone.verify.requested',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { phoneLast4: phoneNumber.slice(-4) }
    });
  }

  return c.json({ success: true, message: 'Verification code sent' });
});

// Phone verification - confirm code (authenticated)
authRoutes.post('/phone/confirm', authMiddleware, zValidator('json', phoneConfirmSchema), async (c) => {
  const auth = c.get('auth');
  const { phoneNumber, code } = c.req.valid('json');

  const twilio = getTwilioService();
  if (!twilio) {
    return c.json({ error: 'SMS service not configured' }, 501);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Rate limit confirmation attempts
  const rateCheck = await rateLimiter(
    redis,
    `sms:phone-confirm:${auth.user.id}`,
    phoneConfirmLimiter.limit,
    phoneConfirmLimiter.windowSeconds
  );
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  }

  const result = await twilio.checkVerificationCode(phoneNumber, code);
  if (result.serviceError) {
    return c.json({ error: 'SMS verification service temporarily unavailable. Please try again.' }, 502);
  }

  const orgId = await resolveUserAuditOrgId(auth.user.id);

  if (!result.valid) {
    if (orgId) {
      writeAuthAudit(c, {
        orgId,
        action: 'auth.phone.verify.failed',
        result: 'failure',
        reason: 'invalid_code',
        userId: auth.user.id,
        email: auth.user.email,
        details: { phoneLast4: phoneNumber.slice(-4) }
      });
    }
    return c.json({ error: 'Invalid verification code' }, 401);
  }

  // Update user with verified phone
  await db
    .update(users)
    .set({
      phoneNumber,
      phoneVerified: true,
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.phone.verify.confirmed',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { phoneLast4: phoneNumber.slice(-4) }
    });
  }

  return c.json({ success: true, message: 'Phone number verified' });
});

// SMS MFA enable (authenticated, requires verified phone)
authRoutes.post('/mfa/sms/enable', authMiddleware, async (c) => {
  const auth = c.get('auth');

  const [user] = await db
    .select({
      phoneNumber: users.phoneNumber,
      phoneVerified: users.phoneVerified,
      mfaEnabled: users.mfaEnabled
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (!user.phoneVerified || !user.phoneNumber) {
    return c.json({ error: 'Phone number must be verified before enabling SMS MFA' }, 400);
  }

  if (user.mfaEnabled) {
    return c.json({ error: 'MFA is already enabled. Disable it first to switch methods.' }, 400);
  }

  // Check org policy — is SMS allowed?
  if (auth.orgId) {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, auth.orgId))
      .limit(1);

    const orgSettings = org?.settings as { security?: { allowedMfaMethods?: { sms?: boolean } } } | null;
    if (orgSettings?.security?.allowedMfaMethods && !orgSettings.security.allowedMfaMethods.sms) {
      return c.json({ error: 'Your organization does not allow SMS MFA' }, 403);
    }
  }

  // Generate recovery codes
  const recoveryCodes = generateRecoveryCodes();

  // Enable SMS MFA
  await db
    .update(users)
    .set({
      mfaEnabled: true,
      mfaMethod: 'sms',
      mfaSecret: null,
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.mfa.setup',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: 'sms' }
    });
  }

  return c.json({ success: true, recoveryCodes, message: 'SMS MFA enabled successfully' });
});

// SMS MFA send code during login (unauthenticated, requires tempToken)
authRoutes.post('/mfa/sms/send', zValidator('json', smsSendSchema), async (c) => {
  const { tempToken } = c.req.valid('json');

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const twilio = getTwilioService();
  if (!twilio) {
    return c.json({ error: 'SMS service not configured' }, 501);
  }

  const pendingRaw = await redis.get(`mfa:pending:${tempToken}`);
  if (!pendingRaw) {
    return c.json({ error: 'Invalid or expired MFA session' }, 401);
  }

  let userId: string;
  try {
    const parsed = JSON.parse(pendingRaw);
    userId = parsed.userId;
  } catch {
    return c.json({ error: 'Invalid MFA session data' }, 400);
  }

  // Look up phone number from DB (never store PII in Redis)
  const [smsUser] = await db
    .select({ phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const phoneNumber = smsUser?.phoneNumber;
  if (!phoneNumber) {
    return c.json({ error: 'No phone number configured for SMS MFA' }, 400);
  }

  // Rate limit per tempToken
  const tokenRate = await rateLimiter(
    redis,
    `sms:login-send:${tempToken}`,
    smsLoginSendLimiter.limit,
    smsLoginSendLimiter.windowSeconds
  );
  if (!tokenRate.allowed) {
    return c.json({ error: 'Too many SMS requests. Try again later.' }, 429);
  }

  // Rate limit per phone globally
  const phoneRate = await rateLimiter(
    redis,
    `sms:login-global:${phoneNumber}`,
    smsLoginGlobalLimiter.limit,
    smsLoginGlobalLimiter.windowSeconds
  );
  if (!phoneRate.allowed) {
    return c.json({ error: 'Too many SMS requests. Try again later.' }, 429);
  }

  const result = await twilio.sendVerificationCode(phoneNumber);
  if (!result.success) {
    return c.json({ error: 'Failed to send SMS code' }, 500);
  }

  const orgId = await resolveUserAuditOrgId(userId);
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.mfa.sms.sent',
      result: 'success',
      userId,
      details: { phoneLast4: phoneNumber.slice(-4) }
    });
  }

  return c.json({ success: true, message: 'SMS code sent' });
});

// Forgot password
authRoutes.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email } = c.req.valid('json');
  const ip = getClientIP(c);
  const normalizedEmail = email.toLowerCase();

  // Rate limit - fail closed for security
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const rateCheck = await rateLimiter(
    redis,
    `forgot:${ip}`,
    forgotPasswordLimiter.limit,
    forgotPasswordLimiter.windowSeconds
  );

  if (!rateCheck.allowed) {
    // Still return success to prevent enumeration
    return c.json({ success: true, message: 'If this email exists, a reset link will be sent.' });
  }

  // Find user (don't reveal if exists)
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (user) {
    // Generate reset token
    const resetToken = nanoid(48);
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');

    // Store token with 1 hour expiry
    await redis.setex(`reset:${tokenHash}`, 3600, user.id);

    const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
    const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
    const emailService = getEmailService();
    if (emailService) {
      try {
        await emailService.sendPasswordReset({
          to: user.email,
          resetUrl
        });
      } catch (error) {
        console.error('[auth] Failed to send password reset email:', error);
      }
    } else {
      console.warn('[Auth] Email service not configured; password reset email was not sent');
    }

    // Log token only in non-production environments
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Password reset token for ${email}: ${resetToken}`);
    }
  } else {
    // Log when password reset cannot be processed (user not found is expected, but Redis unavailability would be caught above)
    console.warn('[auth] Password reset requested for non-existent account');
  }

  // Always return success
  return c.json({ success: true, message: 'If this email exists, a reset link will be sent.' });
});

// Reset password
authRoutes.post('/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  const { token, password } = c.req.valid('json');

  // Validate password strength
  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Password reset unavailable. Please try again later.' }, 503);
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const userId = await redis.get(`reset:${tokenHash}`);

  if (!userId) {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  // Hash new password
  const passwordHash = await hashPassword(password);

  // Update password
  await db
    .update(users)
    .set({
      passwordHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(users.id, userId));

  // Invalidate reset token
  await redis.del(`reset:${tokenHash}`);

  // Invalidate all sessions — best-effort; password is already changed above
  await invalidateAllUserSessions(userId);
  try {
    await revokeAllUserTokens(userId);
  } catch (error) {
    console.error('[auth] Failed to revoke tokens after password reset:', error);
  }

  return c.json({ success: true, message: 'Password reset successfully' });
});

// Change password (requires auth)
authRoutes.post('/change-password', authMiddleware, zValidator('json', changePasswordSchema), async (c) => {
  const auth = c.get('auth');
  const { currentPassword, newPassword } = c.req.valid('json');

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user?.passwordHash) {
    const message = 'Password authentication is not available for this account';
    return c.json({ error: message, message }, 400);
  }

  const validCurrentPassword = await verifyPassword(user.passwordHash, currentPassword);
  if (!validCurrentPassword) {
    const message = 'Current password is incorrect';
    return c.json({ error: message, message }, 401);
  }

  const passwordCheck = isPasswordStrong(newPassword);
  if (!passwordCheck.valid) {
    const message = passwordCheck.errors[0] || 'Password is too weak';
    return c.json({ error: message, message }, 400);
  }

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({
      passwordHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  await invalidateAllUserSessions(auth.user.id);
  try {
    await revokeAllUserTokens(auth.user.id);
    await revokeCurrentRefreshTokenJti(c, auth.user.id);
  } catch (error) {
    console.error('[auth] Failed to revoke tokens after password change:', error);
  }

  return c.json({ success: true, message: 'Password changed successfully' });
});

// MFA enable compatibility endpoint for frontend settings flow
authRoutes.post('/mfa/enable', authMiddleware, zValidator('json', mfaEnableSchema), async (c) => {
  const auth = c.get('auth');
  const { code } = c.req.valid('json');
  const redis = getRedis();

  if (!redis) {
    const message = 'MFA enablement unavailable. Please try again later.';
    return c.json({ error: message, message }, 503);
  }

  const setupData = await redis.get(`mfa:setup:${auth.user.id}`);
  if (!setupData) {
    const message = 'No pending MFA setup';
    return c.json({ error: message, message }, 400);
  }

  let secret: string;
  let recoveryCodes: string[];
  try {
    const parsed = JSON.parse(setupData) as { secret?: unknown; recoveryCodes?: unknown };
    if (typeof parsed.secret !== 'string' || !Array.isArray(parsed.recoveryCodes) || parsed.recoveryCodes.some(code => typeof code !== 'string')) {
      throw new Error('Invalid setup data');
    }
    secret = parsed.secret;
    recoveryCodes = parsed.recoveryCodes;
  } catch {
    const message = 'Invalid MFA setup data';
    return c.json({ error: message, message }, 500);
  }

  const valid = await verifyMFAToken(secret, code);
  if (!valid) {
    const orgId = await resolveUserAuditOrgId(auth.user.id);
    if (orgId) {
      writeAuthAudit(c, {
        orgId,
        action: 'auth.mfa.setup.failed',
        result: 'failure',
        reason: 'invalid_mfa_code',
        userId: auth.user.id,
        email: auth.user.email,
        details: { phase: 'setup_confirmation' }
      });
    }
    const message = 'Invalid MFA code';
    return c.json({ error: message, message }, 401);
  }

  await db
    .update(users)
    .set({
      mfaSecret: encryptMfaSecret(secret),
      mfaEnabled: true,
      mfaMethod: 'totp',
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  await redis.del(`mfa:setup:${auth.user.id}`);

  const setupOrgId = await resolveUserAuditOrgId(auth.user.id);
  if (setupOrgId) {
    writeAuthAudit(c, {
      orgId: setupOrgId,
      action: 'auth.mfa.setup',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: 'totp' }
    });
  }

  return c.json({ success: true, recoveryCodes, message: 'MFA enabled successfully' });
});

// Generate new MFA recovery codes for the authenticated user
authRoutes.post('/mfa/recovery-codes', authMiddleware, async (c) => {
  const auth = c.get('auth');

  const [user] = await db
    .select({ mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user?.mfaEnabled) {
    const message = 'MFA must be enabled before generating recovery codes';
    return c.json({ error: message, message }, 400);
  }

  const recoveryCodes = generateRecoveryCodes();
  await db
    .update(users)
    .set({
      mfaRecoveryCodes: hashRecoveryCodes(recoveryCodes),
      updatedAt: new Date()
    })
    .where(eq(users.id, auth.user.id));

  const orgId = await resolveUserAuditOrgId(auth.user.id);
  if (orgId) {
    writeAuthAudit(c, {
      orgId,
      action: 'auth.mfa.recovery_codes.rotate',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { count: recoveryCodes.length }
    });
  }

  return c.json({ success: true, recoveryCodes, message: 'Recovery codes generated successfully' });
});

// Get current user (requires auth)
authRoutes.get('/me', authMiddleware, async (c) => {
  const auth = c.get('auth');

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      mfaEnabled: users.mfaEnabled,
      mfaMethod: users.mfaMethod,
      phoneNumber: users.phoneNumber,
      phoneVerified: users.phoneVerified,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const { phoneNumber: rawPhone, ...userWithoutPhone } = user;
  return c.json({
    user: {
      ...userWithoutPhone,
      mfaMethod: user.mfaMethod || (user.mfaEnabled ? 'totp' : null),
      phoneLast4: rawPhone?.slice(-4) || null
    }
  });
});
