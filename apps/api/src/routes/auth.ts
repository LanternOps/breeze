import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, sessions } from '../db/schema';
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

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255)
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
// Helper Functions
// ============================================

function getClientIP(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown';
}

function genericAuthError() {
  return { error: 'Invalid email or password' };
}

// ============================================
// Routes
// ============================================

// Register
authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const { email, password, name } = c.req.valid('json');
  const ip = getClientIP(c);

  // Rate limit registration - fail closed for security
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const rateCheck = await rateLimiter(redis, `register:${ip}`, 5, 3600);
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
    // Don't reveal that email exists - return success anyway
    // In production, you'd send an email saying "you already have an account"
    return c.json({ success: true, message: 'If this email is valid, you will receive a confirmation.' });
  }

  // Create user
  const passwordHash = await hashPassword(password);
  const result = await db
    .insert(users)
    .values({
      email: email.toLowerCase(),
      name,
      passwordHash,
      status: 'active'
    })
    .returning();

  const newUser = result[0];
  if (!newUser) {
    return c.json({ error: 'Failed to create user' }, 500);
  }

  // Create tokens
  const tokens = await createTokenPair({
    sub: newUser.id,
    email: newUser.email,
    roleId: null,
    orgId: null,
    partnerId: null,
    scope: 'system'
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
    tokens,
    mfaRequired: false
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
    return c.json(genericAuthError(), 401);
  }

  // Verify password
  const validPassword = await verifyPassword(user.passwordHash, password);
  if (!validPassword) {
    return c.json(genericAuthError(), 401);
  }

  // Check account status
  if (user.status !== 'active') {
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

  // Create tokens
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId: null, // TODO: Fetch from partnerUsers/organizationUsers
    orgId: null,
    partnerId: null,
    scope: 'system'
  });

  // Update last login
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

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
      return c.json({ error: 'Invalid MFA code' }, 401);
    }

    // Clear temp token
    await redis.del(`mfa:pending:${tempToken}`);

    // Create tokens
    const tokens = await createTokenPair({
      sub: user.id,
      email: user.email,
      roleId: null,
      orgId: null,
      partnerId: null,
      scope: 'system'
    });

    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

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
