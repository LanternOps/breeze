import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  hashPassword,
  verifyPassword,
  isPasswordStrong,
  rateLimiter,
  forgotPasswordLimiter,
  getRedis,
  invalidateAllUserSessions,
  revokeAllUserTokens
} from '../../services';
import { getEmailService } from '../../services/email';
import { authMiddleware } from '../../middleware/auth';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { ENABLE_2FA, forgotPasswordSchema, resetPasswordSchema, changePasswordSchema } from './schemas';
import {
  getClientRateLimitKey,
  revokeCurrentRefreshTokenJti
} from './helpers';

const { db } = dbModule;

export const passwordRoutes = new Hono();

// Forgot password
passwordRoutes.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email } = c.req.valid('json');
  const rateLimitClient = getClientRateLimitKey(c);
  const normalizedEmail = email.toLowerCase();

  // Rate limit - fail closed for security
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  const rateCheck = await rateLimiter(
    redis,
    `forgot:${rateLimitClient}`,
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

  } else {
    // Log when password reset cannot be processed (user not found is expected, but Redis unavailability would be caught above)
    console.warn('[auth] Password reset requested for non-existent account');
  }

  // Always return success
  return c.json({ success: true, message: 'If this email exists, a reset link will be sent.' });
});

// Reset password
passwordRoutes.post('/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
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
passwordRoutes.post('/change-password', authMiddleware, zValidator('json', changePasswordSchema), async (c) => {
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

// Get current user (requires auth)
passwordRoutes.get('/me', authMiddleware, async (c) => {
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
  const effectiveMfaEnabled = ENABLE_2FA ? user.mfaEnabled : false;
  return c.json({
    user: {
      ...userWithoutPhone,
      mfaEnabled: effectiveMfaEnabled,
      mfaMethod: effectiveMfaEnabled ? (user.mfaMethod || 'totp') : null,
      phoneLast4: ENABLE_2FA ? (rawPhone?.slice(-4) || null) : null
    }
  });
});
