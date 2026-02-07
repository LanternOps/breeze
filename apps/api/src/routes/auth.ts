import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
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
  getRedis
} from '../services';
import { authMiddleware } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';
import type { RequestLike } from '../services/auditEvents';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';

export const authRoutes = new Hono();

// ============================================
// Schemas
// ============================================

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
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
  tempToken: z.string().optional()
});

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8)
});

const refreshSchema = z.object({
  refreshToken: z.string()
});

// ============================================
// Helpers
// ============================================

function getClientIP(c: RequestLike): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown';
}

function genericAuthError() {
  return { error: 'Invalid email or password' };
}

const ANONYMOUS_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

async function resolveUserAuditOrgId(userId: string): Promise<string | null> {
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

// Register Partner (self-service MSP/company signup)
authRoutes.post('/register-partner', zValidator('json', registerPartnerSchema), async (c) => {
  const { companyName, email, password, name, acceptTerms } = c.req.valid('json');
  const ip = getClientIP(c);

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
    return c.json({ error: 'An account with this email already exists' }, 400);
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
      tokens,
      mfaRequired: false
    });
  } catch (err) {
    console.error('Partner registration error:', err);
    return c.json({ error: 'Registration failed. Please try again.' }, 500);
  }
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
  if (user.mfaEnabled && user.mfaSecret) {
    if (!redis) {
      return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
    }
    // Create a temporary token for MFA verification
    const tempToken = nanoid(32);
    await redis.setex(`mfa:pending:${tempToken}`, 300, user.id); // 5 min expiry

    return c.json({
      mfaRequired: true,
      tempToken,
      user: null,
      tokens: null
    });
  }

  // Look up user's partner/org context
  let roleId: string | null = null;
  let partnerId: string | null = null;
  let orgId: string | null = null;
  let scope: 'system' | 'partner' | 'organization' = 'system';

  // Check for partner association first
  let partnerAssoc:
    | {
        partnerId: string;
        roleId: string;
      }
    | undefined;

  let partnerUsersTable:
    | { partnerId?: unknown; roleId?: unknown; userId?: unknown }
    | undefined;
  try {
    partnerUsersTable = partnerUsers as unknown as { partnerId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
  } catch {
    partnerUsersTable = undefined;
  }
  if (partnerUsersTable?.partnerId && partnerUsersTable?.roleId && partnerUsersTable?.userId) {
    [partnerAssoc] = await db
      .select({
        partnerId: partnerUsers.partnerId,
        roleId: partnerUsers.roleId
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.userId, user.id))
      .limit(1);
  }

  if (partnerAssoc) {
    partnerId = partnerAssoc.partnerId;
    roleId = partnerAssoc.roleId;
    scope = 'partner';
  } else {
    // Check for organization association
    let orgAssoc:
      | {
          orgId: string;
          roleId: string;
        }
      | undefined;

    let organizationUsersTable:
      | { orgId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      organizationUsersTable = organizationUsers as unknown as { orgId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      organizationUsersTable = undefined;
    }
    if (organizationUsersTable?.orgId && organizationUsersTable?.roleId && organizationUsersTable?.userId) {
      [orgAssoc] = await db
        .select({
          orgId: organizationUsers.orgId,
          roleId: organizationUsers.roleId
        })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, user.id))
        .limit(1);
    }

    if (orgAssoc) {
      orgId = orgAssoc.orgId;
      roleId = orgAssoc.roleId;
      scope = 'organization';

      // Get partnerId from org
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgAssoc.orgId))
        .limit(1);

      if (org) {
        partnerId = org.partnerId;
      }
    }
  }

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

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: user.mfaEnabled,
      avatarUrl: user.avatarUrl
    },
    tokens,
    mfaRequired: false
  });
});

// Logout
authRoutes.post('/logout', authMiddleware, async (c) => {
  const auth = c.get('auth');

  // Invalidate all sessions for this user (optional: could invalidate just current session)
  // For now, we're using JWTs which are stateless, but we can add to a blacklist
  const redis = getRedis();
  if (!redis) {
    return c.json({ success: true, warning: 'Session logged out but token may remain valid briefly' }, 200);
  }
  await redis.setex(`token:revoked:${auth.user.id}`, 15 * 60, '1'); // Revoke for access token lifetime

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

  return c.json({ success: true });
});

// Refresh token
authRoutes.post('/refresh', zValidator('json', refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid('json');

  const payload = await verifyToken(refreshToken);

  if (!payload || payload.type !== 'refresh') {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Check if user still exists and is active
  const [user] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user || user.status !== 'active') {
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Create new token pair
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId: payload.roleId,
    orgId: payload.orgId,
    partnerId: payload.partnerId,
    scope: payload.scope
  });

  return c.json({ tokens });
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
  const { code, tempToken } = c.req.valid('json');
  const redis = getRedis();

  if (!redis) {
    return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
  }

  // Case 1: Verifying during login (has tempToken)
  if (tempToken) {
    const userId = await redis.get(`mfa:pending:${tempToken}`);
    if (!userId) {
      return c.json({ error: 'Invalid or expired MFA session' }, 401);
    }

    // Rate limit MFA attempts
    const rateCheck = await rateLimiter(redis, `mfa:${userId}`, mfaLimiter.limit, mfaLimiter.windowSeconds);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many MFA attempts' }, 429);
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.mfaSecret) {
      return c.json({ error: 'Invalid MFA configuration' }, 400);
    }

    const valid = await verifyMFAToken(user.mfaSecret, code);
    if (!valid) {
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'mfa_invalid_code',
        details: { method: 'mfa' }
      });
      return c.json({ error: 'Invalid MFA code' }, 401);
    }

    // Clear temp token
    await redis.del(`mfa:pending:${tempToken}`);

    // Look up user's partner/org context
    let mfaRoleId: string | null = null;
    let mfaPartnerId: string | null = null;
    let mfaOrgId: string | null = null;
    let mfaScope: 'system' | 'partner' | 'organization' = 'system';

    let mfaPartnerAssoc:
      | {
          partnerId: string;
          roleId: string;
        }
      | undefined;

    let partnerUsersTable:
      | { partnerId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      partnerUsersTable = partnerUsers as unknown as { partnerId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      partnerUsersTable = undefined;
    }
    if (partnerUsersTable?.partnerId && partnerUsersTable?.roleId && partnerUsersTable?.userId) {
      [mfaPartnerAssoc] = await db
        .select({ partnerId: partnerUsers.partnerId, roleId: partnerUsers.roleId })
        .from(partnerUsers)
        .where(eq(partnerUsers.userId, user.id))
        .limit(1);
    }

    if (mfaPartnerAssoc) {
      mfaPartnerId = mfaPartnerAssoc.partnerId;
      mfaRoleId = mfaPartnerAssoc.roleId;
      mfaScope = 'partner';
    } else {
      let mfaOrgAssoc:
        | {
            orgId: string;
            roleId: string;
          }
        | undefined;

      let organizationUsersTable:
        | { orgId?: unknown; roleId?: unknown; userId?: unknown }
        | undefined;
      try {
        organizationUsersTable = organizationUsers as unknown as { orgId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
      } catch {
        organizationUsersTable = undefined;
      }
      if (organizationUsersTable?.orgId && organizationUsersTable?.roleId && organizationUsersTable?.userId) {
        [mfaOrgAssoc] = await db
          .select({ orgId: organizationUsers.orgId, roleId: organizationUsers.roleId })
          .from(organizationUsers)
          .where(eq(organizationUsers.userId, user.id))
          .limit(1);
      }

      if (mfaOrgAssoc) {
        mfaOrgId = mfaOrgAssoc.orgId;
        mfaRoleId = mfaOrgAssoc.roleId;
        mfaScope = 'organization';

        const [mfaOrg] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, mfaOrgAssoc.orgId))
          .limit(1);

        if (mfaOrg) {
          mfaPartnerId = mfaOrg.partnerId;
        }
      }
    }

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

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: true
      },
      tokens,
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

  // Enable MFA
  await db
    .update(users)
    .set({
      mfaSecret: secret,
      mfaEnabled: true,
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

  // TODO: Store recovery codes hashed in database

  return c.json({ success: true, message: 'MFA enabled successfully' });
});

// MFA disable (requires auth + current MFA code)
authRoutes.post('/mfa/disable', authMiddleware, zValidator('json', mfaVerifySchema), async (c) => {
  const auth = c.get('auth');
  const { code } = c.req.valid('json');

  const [user] = await db
    .select({ mfaSecret: users.mfaSecret, mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user?.mfaEnabled || !user.mfaSecret) {
    return c.json({ error: 'MFA is not enabled' }, 400);
  }

  const valid = await verifyMFAToken(user.mfaSecret, code);
  if (!valid) {
    if (auth.orgId) {
      writeAuthAudit(c, {
        orgId: auth.orgId,
        action: 'auth.mfa.disable.failed',
        result: 'failure',
        reason: 'invalid_mfa_code',
        userId: auth.user.id,
        email: auth.user.email,
        details: { method: 'mfa' }
      });
    }
    return c.json({ error: 'Invalid MFA code' }, 401);
  }

  await db
    .update(users)
    .set({
      mfaSecret: null,
      mfaEnabled: false,
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
      details: { method: 'totp' }
    });
  }

  return c.json({ success: true, message: 'MFA disabled successfully' });
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

    // TODO: Send email with reset link
    // Log token only in non-production environments
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Password reset token for ${email}: ${resetToken}`);
    }
  } else {
    // Log when password reset cannot be processed (user not found is expected, but Redis unavailability would be caught above)
    console.warn(`Password reset requested for non-existent email: ${normalizedEmail}`);
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

  // Invalidate all sessions
  await invalidateAllUserSessions(userId);

  return c.json({ success: true, message: 'Password reset successfully' });
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

  return c.json({ user });
});
