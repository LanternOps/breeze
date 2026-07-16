import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { z } from 'zod';
import * as dbModule from '../../db';
import { users, partners, roles } from '../../db/schema';
import type { PartnerStatus } from '../../db/schema/orgs';
import {
  rateLimiter,
  getRedis,
  createTokenPair,
  mintRefreshTokenFamily,
  bindRefreshJtiToFamily,
  getUserEpochs,
} from '../../services';
import { getEmailService } from '../../services/email';
import {
  consumeVerificationToken,
  generateVerificationToken,
  invalidateOpenTokens,
} from '../../services/emailVerification';
import {
  consumePendingRegistration,
  rewritePendingRegistration,
  type PendingRegistration,
} from '../../services/pendingRegistration';
import { createPartner } from '../../services/partnerCreate';
import { combineMfaPolicyFacts, type MfaSecuritySettings } from '../../services/mfaPolicy';
import { dispatchHook } from '../../services/partnerHooks';
import { writeAuditEvent } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { isHosted } from '../../config/env';
import { ENABLE_REGISTRATION, ENABLE_2FA } from './schemas';
import { authMiddleware } from '../../middleware/auth';
import { runPostCommitCleanup } from '../../services/authLifecycle';
import {
  getClientRateLimitKey,
  writeAuthAudit,
  setRefreshTokenCookie,
  toPublicTokens,
} from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

const PENDING_REG_TTL_SECONDS = 3600;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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

    // SR2-21 step 2: a submitted token is FIRST tried as a pending registration
    // (email-first signup — the account does not exist yet and gets created
    // HERE, the ONLY registration account-creation + session-mint site now).
    // consumePendingRegistration is a single-winner GETDEL: a second click gets
    // null and falls through to the ordinary verification path below.
    const pending = await consumePendingRegistration(sha256Hex(token));
    if (pending) {
      return finalizePendingRegistration(c, pending, token);
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

/**
 * SR2-21 step 2 — the email-first signup finalizer. This is the ONLY place a
 * partner registration creates the tenant AND mints the auto-login session; the
 * account did not exist until this click. `rawToken` is the exact token the user
 * submitted (identical to the raw token parked in Redis), used only to re-park
 * the record if createPartner fails after the single-winner consume removed it.
 */
async function finalizePendingRegistration(
  c: Context,
  rec: PendingRegistration,
  rawToken: string,
): Promise<Response> {
  // 1. Policy re-check. A flip between step 1 and step 2 (registration disabled,
  //    or the hosted/self-hosted mode changed) denies — fail closed, generic
  //    400. The pending record was already consumed; that is fine, it is dead.
  if (!ENABLE_REGISTRATION || isHosted() !== rec.hostedExpectation) {
    writeAuthAudit(c, {
      action: 'auth.email_verify_failed',
      result: 'failure',
      reason: 'registration_policy_changed',
      email: rec.email,
    });
    return c.json({ error: 'Invalid or expired verification link' }, 400);
  }

  const normalizedEmail = rec.email.toLowerCase().trim();

  // 2. Global uniqueness re-check under a system context (users is FORCE-RLS).
  //    The address may have been registered while the link sat in the mailbox.
  //    Direct the holder — who, by holding this token, controls the mailbox — to
  //    sign in, and create nothing. This discloses "already registered" only to
  //    whoever controls the address, which the design explicitly permits.
  const [existing] = await withSystemDbAccessContext(() =>
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1),
  );
  if (existing) {
    writeAuthAudit(c, {
      action: 'auth.email_verified',
      result: 'denied',
      reason: 'already_registered',
      email: rec.email,
    });
    return c.json({ verified: false, status: 'sign_in' as const }, 200);
  }

  // 3. Create the partner (its own committed transaction — this handler holds no
  //    outer tx). Threads the STEP-1 abuse attribution (#2343), never the click's
  //    IP/UA. On failure the single-winner consume has already removed the
  //    record, so re-park it (best effort) with the remaining TTL and return a
  //    generic 500 so the user can click the same link again.
  let created;
  try {
    created = await createPartner({
      orgName: rec.companyName,
      adminEmail: rec.email,
      adminName: rec.name,
      passwordHash: rec.passwordHash,
      origin: { mcp: false, ip: rec.signupIp, userAgent: rec.signupUserAgent },
      status: rec.hostedExpectation ? 'pending' : 'active',
    });
  } catch (err) {
    console.error('[verify-email] pending-registration createPartner failed', err);
    captureException(err, c);
    const remainingTtl = PENDING_REG_TTL_SECONDS - Math.floor((Date.now() - rec.createdAt) / 1000);
    await rewritePendingRegistration(sha256Hex(rawToken), { ...rec, rawToken }, remainingTtl).catch(
      (reparkErr) => console.error('[verify-email] pending-registration re-park failed', reparkErr),
    );
    return c.json({ error: 'Registration failed. Please try again.' }, 500);
  }

  try {
    // 4. createPartner COMMITTED before we read, so these reads under a fresh
    //    system context SEE the committed rows — the Task-2 fail-open (reading
    //    still-uncommitted signup rows on a second connection → policy always
    //    "not required" → vacuous mfa=true) cannot recur here. Fail closed: any
    //    missing row throws to the 500 below, before a token is minted. We also
    //    stamp email_verified_at on both rows — the click proves the address.
    const now = new Date();
    const facts = await withSystemDbAccessContext(async () => {
      const [partnerRow] = await db
        .select({
          id: partners.id,
          name: partners.name,
          slug: partners.slug,
          plan: partners.plan,
          status: partners.status,
          settings: partners.settings,
        })
        .from(partners)
        .where(eq(partners.id, created.partnerId))
        .limit(1);
      const [userRow] = await db
        .select({ id: users.id, email: users.email, name: users.name, mfaEnabled: users.mfaEnabled })
        .from(users)
        .where(eq(users.id, created.adminUserId))
        .limit(1);
      const [roleRow] = await db
        .select({ forceMfa: roles.forceMfa })
        .from(roles)
        .where(eq(roles.id, created.adminRoleId))
        .limit(1);

      if (!partnerRow || !userRow || !roleRow) {
        throw new Error('Partner, user or admin-role row missing after createPartner');
      }

      await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, created.adminUserId));
      await db
        .update(partners)
        .set({ emailVerifiedAt: now, updatedAt: now })
        .where(eq(partners.id, created.partnerId));

      return { partnerRow, userRow, roleRow };
    });

    // Effective MFA policy at the auto-login mint — the Task-2 contract. A
    // just-created user holds no factor, so the old `mfaSatisfied` was a vacuous
    // constant `true`. Resolve the policy from the committed role/settings facts
    // and apply the shared strictest-wins rule (combineMfaPolicyFacts).
    const partnerSettings = (facts.partnerRow.settings ?? {}) as Record<string, unknown>;
    const policy = combineMfaPolicyFacts({
      roleForceMfa: facts.roleRow.forceMfa === true,
      security: partnerSettings.security as MfaSecuritySettings | undefined,
      failClosed: true,
    });
    const mfaEnrollmentRequired = ENABLE_2FA && !facts.userRow.mfaEnabled && policy.required;
    const mfaSatisfied = !ENABLE_2FA || (!facts.userRow.mfaEnabled && !policy.required);

    // Mint a fresh refresh-token family so the first session inherits the same
    // reuse-detection chain as a real /login.
    const registerFamilyId = await mintRefreshTokenFamily(created.adminUserId);
    const epochs = await getUserEpochs(created.adminUserId);
    if (!epochs) throw new Error('user epochs unavailable at token mint');
    const tokens = await createTokenPair(
      {
        sub: created.adminUserId,
        email: facts.userRow.email,
        roleId: created.adminRoleId,
        orgId: created.orgId,
        partnerId: created.partnerId,
        scope: 'partner',
        mfa: mfaSatisfied,
        aep: epochs.authEpoch,
        mep: epochs.mfaEpoch,
      },
      { refreshFam: registerFamilyId },
    );
    await bindRefreshJtiToFamily(tokens.refreshJti, registerFamilyId);
    setRefreshTokenCookie(c, tokens.refreshToken);

    // Post-registration hook (external services can override status/redirect).
    const hookResponse = await dispatchHook('registration', created.partnerId, {
      email: facts.userRow.email,
      partnerName: facts.partnerRow.name,
      plan: facts.partnerRow.plan,
    });

    const VALID_STATUSES = ['pending', 'active', 'suspended', 'churned'] as const;
    let effectiveStatus: PartnerStatus = facts.partnerRow.status;
    if (hookResponse?.status && hookResponse.status !== facts.partnerRow.status) {
      if (!VALID_STATUSES.includes(hookResponse.status as never)) {
        console.error(
          `[verify-email] Hook returned invalid status '${hookResponse.status}' for partner ${created.partnerId}; ignoring`,
        );
      } else {
        try {
          const updateSet: Record<string, unknown> = { status: hookResponse.status };
          if (hookResponse.message || hookResponse.actionUrl || hookResponse.actionLabel) {
            const msgSettings: Record<string, string | null> = {};
            if (hookResponse.message) msgSettings.statusMessage = hookResponse.message;
            if (hookResponse.actionUrl) msgSettings.statusActionUrl = hookResponse.actionUrl;
            if (hookResponse.actionLabel) msgSettings.statusActionLabel = hookResponse.actionLabel;
            updateSet.settings = sql`COALESCE(${partners.settings}, '{}'::jsonb) || ${JSON.stringify(msgSettings)}::jsonb`;
          }
          await withSystemDbAccessContext(() =>
            db.update(partners).set(updateSet).where(eq(partners.id, created.partnerId)),
          );
          effectiveStatus = hookResponse.status as PartnerStatus;
        } catch (statusErr) {
          console.error('[verify-email] hook-status update failed', {
            partnerId: created.partnerId,
            error: statusErr instanceof Error ? statusErr.message : String(statusErr),
          });
          writeAuditEvent(c, {
            orgId: null,
            actorType: 'system',
            action: 'register-partner.hook-status-update-failed',
            resourceType: 'partner',
            resourceId: created.partnerId,
            resourceName: facts.partnerRow.name,
            details: { fromStatus: facts.partnerRow.status, toStatus: hookResponse.status },
            result: 'failure',
            errorMessage: statusErr instanceof Error ? statusErr.message : String(statusErr),
          });
        }
      }
    }

    // Only allow relative redirects from hooks (open-redirect guard).
    const redirectUrl = hookResponse?.redirectUrl?.startsWith('/') ? hookResponse.redirectUrl : undefined;

    writeAuthAudit(c, {
      action: 'auth.email_verified',
      result: 'success',
      userId: created.adminUserId,
      email: facts.userRow.email,
      details: { partnerId: created.partnerId, registration: true },
    });

    return c.json({
      verified: true,
      user: { id: created.adminUserId, email: facts.userRow.email, name: facts.userRow.name, mfaEnabled: false },
      partner: { id: created.partnerId, name: facts.partnerRow.name, slug: facts.partnerRow.slug, status: effectiveStatus },
      tokens: toPublicTokens(tokens),
      mfaRequired: false,
      mfaEnrollmentRequired,
      enrollUrl: mfaEnrollmentRequired ? '/auth/mfa/setup' : undefined,
      ...(redirectUrl ? { redirectUrl } : {}),
    });
  } catch (err) {
    // The partner is already committed; the user can sign in normally. Do NOT
    // re-park (that would let a re-click create a duplicate, which the step-2
    // uniqueness check would then bounce to sign_in anyway). Surface a 500.
    console.error('[verify-email] pending-registration finalize failed after createPartner', {
      partnerId: created.partnerId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, c);
    return c.json({ error: 'Registration failed. Please try again.' }, 500);
  }
}
