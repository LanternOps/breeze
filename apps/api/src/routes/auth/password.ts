import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
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
  invalidateAllUserSessions
} from '../../services';
import { getEmailService } from '../../services/email';
import { authMiddleware } from '../../middleware/auth';
import {
  getPasswordResetEligibility,
  getPasswordResetEligibilityForUser,
} from '../../services/passwordResetEligibility';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { ENABLE_2FA, forgotPasswordSchema, resetPasswordSchema, changePasswordSchema } from './schemas';
import {
  getClientRateLimitKey,
  revokeCurrentRefreshTokenJti,
  resolveUserAuditOrgId,
  writeAuthAudit
} from './helpers';
import { assertPasswordAuthAllowedBySso, SsoPasswordAuthRequiredError } from './ssoPolicy';
import { advanceUserEpochs, revokeAllRefreshFamilies, runPostCommitCleanup } from '../../services/authLifecycle';

const { db, withSystemDbAccessContext } = dbModule;

export const passwordRoutes = new Hono();

// SR2-08: the reset token's Redis value is a JSON envelope binding the token
// to the generation (password_reset_epoch) and the exact normalized email it
// was issued for. Only the newest generation, bound to the address it was
// issued for, can redeem — an older/superseded token fails closed even if
// unexpired (closes the sibling-token account-takeover window).
interface ResetTokenEnvelope {
  userId: string;
  passwordResetEpoch: number;
  email: string;
}

async function consumePasswordResetToken(
  redis: ReturnType<typeof getRedis>,
  tokenHash: string,
): Promise<string | null> {
  if (!redis) return null;

  const key = `reset:${tokenHash}`;
  const redisWithGetDel = redis as typeof redis & {
    getdel?: (key: string) => Promise<string | null>;
    eval?: (script: string, keyCount: number, ...keys: string[]) => Promise<unknown>;
  };

  if (typeof redisWithGetDel.getdel === 'function') {
    return redisWithGetDel.getdel(key);
  }

  if (typeof redisWithGetDel.eval === 'function') {
    const raw = await redisWithGetDel.eval(`
      local value = redis.call('GET', KEYS[1])
      if value then
        redis.call('DEL', KEYS[1])
      end
      return value
    `, 1, key);
    return typeof raw === 'string' ? raw : null;
  }

  throw new Error('Redis client does not support atomic password reset token consumption');
}

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

  // Centralized policy — same helper used by /reset-password so the two
  // phases of the flow share one definition of "eligible". `pending`
  // partners are eligible here (closes #719); `suspended` / `churned` /
  // disabled users are not, but the response is always a generic 200 to
  // defeat email-enumeration.
  const eligibility = await getPasswordResetEligibility(normalizedEmail);

  if (eligibility.allowed && eligibility.userId && eligibility.email) {
    // Generate reset token
    const resetToken = nanoid(48);
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');

    // SR2-08: advance password_reset_epoch and bind the token to the new
    // generation + the exact normalized email it was issued for. Pre-auth
    // path — there is no ambient DB context, so a bare db.transaction would
    // hit `users` as breeze_app with no GUCs and the UPDATE would be
    // RLS-filtered to 0 rows (advanceUserEpochs then throws "user not
    // found"). Wrap in the system context.
    const gen = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) =>
        advanceUserEpochs(tx, eligibility.userId!, { passwordReset: true })
      )
    );
    const envelope: ResetTokenEnvelope = {
      userId: eligibility.userId,
      passwordResetEpoch: gen.passwordResetEpoch,
      email: normalizedEmail,
    };
    // Store token with 1 hour expiry
    await redis.setex(`reset:${tokenHash}`, 3600, JSON.stringify(envelope));

    const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
    const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
    const emailService = getEmailService();
    if (emailService) {
      try {
        await emailService.sendPasswordReset({
          to: eligibility.email,
          resetUrl
        });
      } catch (error) {
        console.error('[auth] Failed to send password reset email:', error);
      }
    } else {
      console.warn('[Auth] Email service not configured; password reset email was not sent');
    }

    writeAuthAudit(c, {
      action: 'user.password.reset.requested',
      result: 'success',
      userId: eligibility.userId,
      email: eligibility.email,
    });
  } else if (eligibility.reason === 'unknown_user') {
    // Expected — keep response indistinguishable to defeat enumeration.
    console.warn('[auth] Password reset requested for non-existent account');
  } else if (eligibility.userId) {
    // Known user, blocked for policy reasons (SSO required / tenant
    // inactive / user disabled). Log the denial for ops visibility. The
    // `detail` (e.g. `partner:suspended`) is recorded server-side only —
    // never in the HTTP response (#719 residual 1).
    writeAuthAudit(c, {
      action: 'user.password.reset.requested',
      result: 'denied',
      reason: eligibility.reason,
      userId: eligibility.userId,
      email: eligibility.email,
      details: eligibility.detail ? { detail: eligibility.detail } : undefined,
    });
    // #719 residual 2: feed the anomaly metric so a spike of inactive-tenant
    // reset attempts is alertable. Reuses the existing failed-login counter
    // (breeze_failed_logins_total) — the metric is server-side only and never
    // leaves an enumeration trail in any response.
    if (eligibility.reason === 'tenant_inactive') {
      recordFailedLogin('reset_tenant_inactive');
    }
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
  const raw = await consumePasswordResetToken(redis, tokenHash);

  if (!raw) {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  let envelope: ResetTokenEnvelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }
  const userId = envelope.userId;

  // SR2-08: reload the live generation + email and require BOTH to match
  // the envelope. A newer reset request, a completed reset, or a password
  // change all advance password_reset_epoch — so only the newest generation,
  // bound to the address it was issued for, can redeem. Fails closed even
  // if the token is otherwise unexpired.
  const [live] = await withSystemDbAccessContext(async () =>
    db.select({ passwordResetEpoch: users.passwordResetEpoch, email: users.email })
      .from(users).where(eq(users.id, userId)).limit(1)
  );
  if (!live ||
      live.passwordResetEpoch !== envelope.passwordResetEpoch ||
      live.email.toLowerCase() !== envelope.email.toLowerCase()) {
    // A newer reset was issued, the password already changed, or the address
    // moved — only the newest generation bound to the current address wins.
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  // Re-evaluate eligibility at consumption time — if the partner was
  // suspended between issuing the token and the user clicking the reset
  // link, we must not let the reset complete. Same policy helper as
  // /forgot-password so the two phases of the flow can't drift (#719).
  const eligibility = await getPasswordResetEligibilityForUser(userId);
  if (!eligibility.allowed) {
    if (eligibility.reason === 'sso_required') {
      writeAuthAudit(c, {
        action: 'user.password.reset',
        result: 'denied',
        reason: 'sso_required',
        userId,
      });
      return c.json({ error: 'Password reset is disabled because your organization requires SSO.' }, 403);
    }

    writeAuthAudit(c, {
      action: 'user.password.reset',
      result: 'denied',
      reason: eligibility.reason,
      userId,
      details: eligibility.detail ? { detail: eligibility.detail } : undefined,
    });
    // #719 residual 2: a tenant that flipped inactive between token-issue and
    // token-consume is exactly the "trap class" we want visibility on. Count
    // it (server-side metric only).
    if (eligibility.reason === 'tenant_inactive') {
      recordFailedLogin('reset_tenant_inactive');
    }
    // For all other ineligible reasons (tenant_inactive, user_disabled,
    // unknown_user) surface the same generic error as an expired token
    // — never leak partner-status to the client.
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  // Hash new password
  const passwordHash = await hashPassword(password);

  // Pre-auth path: no session means RLS context is empty, and the
  // breeze_user_isolation_update policy on `users` requires partner/org
  // /self context. Without the system-scope wrap, Drizzle issues an
  // UPDATE that matches zero rows and silently returns success — the
  // password never changes, the next login fails, and we ship a broken
  // reset flow. Wrap so RLS is bypassed for this trusted token-gated
  // path. Same fix needed in accept-invite (see invite.ts).
  //
  // SR2-08: the password write, the auth-epoch + password-reset-epoch
  // advance, and the durable refresh-family revoke all land in ONE
  // transaction — a successful reset must atomically supersede every
  // sibling reset token AND every existing session/refresh family.
  await withSystemDbAccessContext(async () =>
    db.transaction(async (tx) => {
      await tx.update(users)
        .set({
          passwordHash,
          passwordChangedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));
      await advanceUserEpochs(tx, userId, { auth: true, passwordReset: true });
      await revokeAllRefreshFamilies(tx, userId, 'password-reset');
    })
  );

  // Invalidate all sessions — separate legacy mechanism, not absorbed by the
  // lifecycle service (overseer decision 2026-07-11); best-effort, password
  // is already changed and durably committed above.
  await invalidateAllUserSessions(userId);
  // Post-commit cleanup (Redis JWT cutoff + permission-cache clear + MCP
  // OAuth grant sweep) — best-effort and independent per step; the durable
  // revocation above is already committed regardless of outcome here.
  await runPostCommitCleanup(userId);

  // Audit log
  const auditOrgId = await resolveUserAuditOrgId(userId);
  writeAuthAudit(c, {
    orgId: auditOrgId ?? undefined,
    action: 'user.password.reset',
    result: 'success',
    userId,
  });

  return c.json({ success: true, message: 'Password reset successfully' });
});

// Change password (requires auth)
passwordRoutes.post('/change-password', authMiddleware, zValidator('json', changePasswordSchema), async (c) => {
  const auth = c.get('auth');
  const { currentPassword, newPassword } = c.req.valid('json');

  try {
    await assertPasswordAuthAllowedBySso({
      scope: auth.scope,
      orgId: auth.orgId,
      partnerId: auth.partnerId
    });
  } catch (error) {
    if (!(error instanceof SsoPasswordAuthRequiredError)) throw error;
    return c.json({
      error: 'Password changes are disabled because your organization requires SSO.',
      message: 'Password changes are disabled because your organization requires SSO.'
    }, 403);
  }

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
  // SR2-08: same in-transaction epoch-advance + durable family revoke as
  // /reset-password. This path runs authenticated as the user themselves,
  // so the user-id-scoped refresh_token_families RLS policy admits the
  // write and the `users` self-update passes the self policy — no
  // system-context wrap needed (unlike the two pre-auth paths above).
  await db.transaction(async (tx) => {
    await tx.update(users)
      .set({
        passwordHash,
        passwordChangedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(users.id, auth.user.id));
    await advanceUserEpochs(tx, auth.user.id, { auth: true, passwordReset: true });
    await revokeAllRefreshFamilies(tx, auth.user.id, 'password-change');
  });

  // Invalidate all sessions — separate legacy mechanism, not absorbed by the
  // lifecycle service (overseer decision 2026-07-11); best-effort, password
  // is already changed and durably committed above.
  await invalidateAllUserSessions(auth.user.id);
  // Cheap hot-path marker for the caller's own cookie — decoupled from the
  // durable per-family revoke above so a Redis blip here can't roll it back.
  await revokeCurrentRefreshTokenJti(c, auth.user.id).catch((error) =>
    console.error('[auth] Failed to revoke current refresh token after password change:', error),
  );
  // Post-commit cleanup (Redis JWT cutoff + permission-cache clear + MCP
  // OAuth grant sweep) — best-effort and independent per step; the durable
  // revocation above is already committed regardless of outcome here.
  await runPostCommitCleanup(auth.user.id);

  // Audit log
  const changeAuditOrgId = await resolveUserAuditOrgId(auth.user.id);
  writeAuthAudit(c, {
    orgId: changeAuditOrgId ?? undefined,
    action: 'user.password.change',
    result: 'success',
    userId: auth.user.id,
    email: auth.user.email,
  });

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
