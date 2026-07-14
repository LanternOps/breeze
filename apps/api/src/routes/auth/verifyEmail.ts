import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import { rateLimiter, getRedis } from '../../services';
import { getEmailService } from '../../services/email';
import {
  consumeVerificationToken,
  generateVerificationToken,
  invalidateOpenTokens,
} from '../../services/emailVerification';
import { authMiddleware } from '../../middleware/auth';
import { runPostCommitCleanup } from '../../services/authLifecycle';
import { getClientRateLimitKey, writeAuthAudit } from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

export const verifyEmailRoutes = new Hono();

const verifyEmailSchema = z.object({
  token: z.string().min(1, 'token required'),
});

verifyEmailRoutes.post(
  '/verify-email',
  zValidator('json', verifyEmailSchema),
  async (c) => {
    const { token } = c.req.valid('json');
    const rateLimitClient = getClientRateLimitKey(c);

    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    const rateCheck = await rateLimiter(redis, `verify-email:${rateLimitClient}`, 10, 300);
    if (!rateCheck.allowed) {
      writeAuthAudit(c, {
        action: 'auth.email_verify_failed',
        result: 'denied',
        reason: 'rate_limited',
      });
      return c.json({ error: 'Too many verification attempts. Try again later.' }, 429);
    }

    const result = await consumeVerificationToken(token);

    if (!result.ok) {
      // The real reason is AUDIT-ONLY. Returning it verbatim
      // ('address_changed' vs 'invalid' vs 'email_taken') is an enumeration
      // oracle: it tells the holder of a random token whether the token existed
      // and how it failed. Every failure gets ONE identical public body.
      writeAuthAudit(c, {
        action: 'auth.email_verify_failed',
        result: 'failure',
        reason: result.error,
      });
      return c.json({ error: 'Invalid or expired verification link' }, 400);
    }

    // SR2-17: the pending address has just been swapped in, the user has been
    // signed out durably (auth_epoch + family revoke committed in the same
    // transaction), and now the hot-path cleanup + completion notice run
    // out-of-band. Kept OUT of the consume transaction on purpose: they are
    // best-effort side effects (Redis cutoff, permission cache, OAuth grant
    // sweep, email) that must not roll back a committed identity change.
    if (result.purpose === 'email_change') {
      const cleanup = await runPostCommitCleanup(result.userId);

      const previousEmail = result.previousEmail;
      if (previousEmail) {
        const emailService = getEmailService();
        if (emailService) {
          // The completion notice goes to the OLD (now-abandoned) address: the
          // change it was warned about at initiation has now taken effect.
          await emailService
            .sendEmailChanged({ to: previousEmail, newEmail: result.email, pending: false })
            .catch((err: unknown) => {
              console.error('[verify-email] email-change completion notice failed', err);
            });
        } else {
          console.warn('[verify-email] Email service not configured; completion notice not sent');
        }
      }

      writeAuthAudit(c, {
        action: 'auth.email.change.committed',
        result: 'success',
        userId: result.userId,
        email: result.email,
        details: {
          partnerId: result.partnerId,
          previousEmail,
          newEmail: result.email,
          // The durable revoke committed with the swap; these flags record
          // whether the best-effort out-of-band cleanup fully succeeded.
          redisCutoffOk: cleanup.redisOk,
          permissionCacheOk: cleanup.permissionCacheOk,
          oauthRevocationOk: cleanup.oauthOk,
        },
      });

      return c.json({
        verified: true,
        purpose: 'email_change' as const,
        email: result.email,
      });
    }

    writeAuthAudit(c, {
      action: 'auth.email_verified',
      result: 'success',
      userId: result.userId,
      email: result.email,
      details: {
        partnerId: result.partnerId,
        autoActivated: result.autoActivated,
      },
    });

    return c.json({
      verified: true,
      partnerId: result.partnerId,
      email: result.email,
      autoActivated: result.autoActivated,
    });
  }
);

verifyEmailRoutes.post('/resend-verification', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const userId = auth.user.id;
  const rateLimitClient = getClientRateLimitKey(c);

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Two windows: 1 per minute (debounce form spam) + 5 per hour (abuse cap).
  const minuteCheck = await rateLimiter(redis, `resend-verify:min:${userId}:${rateLimitClient}`, 1, 60);
  if (!minuteCheck.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((minuteCheck.resetAt.getTime() - Date.now()) / 1000),
    );
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json(
      {
        error: `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'} before requesting another verification email.`,
        retryAfterSeconds,
        window: 'minute' as const,
      },
      429,
    );
  }
  const hourCheck = await rateLimiter(redis, `resend-verify:hour:${userId}`, 5, 3600);
  if (!hourCheck.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((hourCheck.resetAt.getTime() - Date.now()) / 1000),
    );
    const retryAfterMinutes = Math.ceil(retryAfterSeconds / 60);
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json(
      {
        error: `Verification email limit reached. Try again in ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? '' : 's'}.`,
        retryAfterSeconds,
        window: 'hour' as const,
      },
      429,
    );
  }

  const [user] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        partnerId: users.partnerId,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (user.emailVerifiedAt) {
    return c.json({ error: 'already_verified' }, 400);
  }

  await invalidateOpenTokens(user.id);

  const rawToken = await generateVerificationToken({
    partnerId: user.partnerId,
    userId: user.id,
    email: user.email,
  });

  const appBaseUrl = (
    process.env.DASHBOARD_URL ||
    process.env.PUBLIC_APP_URL ||
    'http://localhost:4321'
  ).replace(/\/$/, '');
  const verificationUrl = `${appBaseUrl}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;

  const emailService = getEmailService();
  if (!emailService) {
    console.warn('[resend-verification] Email service not configured');
    writeAuthAudit(c, {
      action: 'auth.verification_resent',
      result: 'failure',
      reason: 'email_service_unavailable',
      userId: user.id,
      email: user.email,
    });
    return c.json({ error: 'Email service unavailable' }, 503);
  }

  try {
    await emailService.sendVerificationEmail({
      to: user.email,
      name: user.name,
      verificationUrl,
    });
  } catch (err) {
    console.error('[resend-verification] failed to send email', {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    writeAuthAudit(c, {
      action: 'auth.verification_resent',
      result: 'failure',
      reason: 'send_failed',
      userId: user.id,
      email: user.email,
    });
    return c.json({ error: 'Failed to send verification email' }, 500);
  }

  writeAuthAudit(c, {
    action: 'auth.verification_resent',
    result: 'success',
    userId: user.id,
    email: user.email,
  });

  return c.json({ sent: true });
});
