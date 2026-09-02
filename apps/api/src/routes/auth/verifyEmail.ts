import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { z } from 'zod';
import * as dbModule from '../../db';
import { users, partners, roles } from '../../db/schema';
import type { PartnerStatus, PartnerTrustState } from '../../db/schema/orgs';
import {
  rateLimiter,
  getRedis,
} from '../../services';
import { getEmailService } from '../../services/email';
import {
  consumeVerificationToken,
  generateVerificationToken,
  invalidateOpenTokens,
} from '../../services/emailVerification';
import {
  consumePendingRegistration,
  peekPendingRegistration,
  type PendingRegistration,
} from '../../services/pendingRegistration';
import { createPartner } from '../../services/partnerCreate';
import { combineMfaPolicyFacts, type MfaSecuritySettings } from '../../services/mfaPolicy';
import { dispatchHook } from '../../services/partnerHooks';
import { ANONYMOUS_ACTOR_ID, writeAuditEvent } from '../../services/auditEvents';
import { createAuditLog } from '../../services/auditService';
import { captureException } from '../../services/sentry';
import { isHosted } from '../../config/env';
import { ENABLE_REGISTRATION, ENABLE_2FA } from './schemas';
import { authMiddleware } from '../../middleware/auth';
import {
  advanceUserEpochs,
  lockActiveRefreshFamiliesForUsers,
  revokeAllRefreshFamilies,
  runPostCommitCleanup,
  type Tx as AuthLifecycleTransaction,
} from '../../services/authLifecycle';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  cancelAuthIssuance,
  finishAuthIssuance,
  type AuthIssuanceCapability,
} from '../../services/authBrowserTransition';
import {
  authBrowserTransitionsEnforced,
  bindIssuedUserSession,
  issueUserSession,
  issueUserSessionLegacyDuringTransition,
  type AuthorizedUserSession,
  type UserSessionIdentity,
} from '../../services/userSession';
import { recordAuthTransitionLegacyIssuer } from '../../services/authTransitionMetrics';
import { activatePendingPartnerAndInvalidateSessions } from '../../services/partnerActivation';
import {
  getClientRateLimitKey,
  writeAuthAudit,
  toPublicTokens,
  isAuthTransitionV1Request,
  authClientUpgradeRequiredResponse,
  installAuthorizedUserSessionCookies,
  installLegacyUserSessionCookiesDuringTransition,
} from './helpers';
import { installAuthBindingReplacement, requestAuthBinding } from './binding';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { partnerTrustMode } from '../../config/partnerTrustMode';
import { enqueueIpClassify } from '../../services/ipClassify';

const { db, withSystemDbAccessContext } = dbModule;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The hook's `actionUrl` is persisted to `partners.settings` and then served to
 * clients by BOTH `/partner/me` and the `partnerGuard` 403 body, where it is
 * rendered as a link. The web island guards with its own `isSafeUrl`, but every
 * other consumer of that 403 (mobile, future clients) does not — so reject
 * anything that isn't http(s) at the point of storage rather than trusting each
 * reader. `javascript:` and `data:` are the payloads that matter here.
 */
/**
 * A hook-supplied redirect target is only safe if it is a single-slash relative
 * path. `//evil.com` passes a naive `startsWith('/')` and is protocol-relative,
 * and `/\evil.com` is normalized to the same host by some browsers. Control
 * characters are rejected so this cannot be smuggled into a header later.
 * Kept in sync with `apps/web/src/lib/authNext.ts::getSafeNext`.
 */
function isSafeRelativeRedirect(url: string | undefined): boolean {
  if (!url || !url.startsWith('/')) return false;
  if (url.length > 1 && (url[1] === '/' || url[1] === '\\')) return false;
  return !/[\x00-\x1F\x7F]/.test(url);
}

function isSafeHookActionUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const REGISTRATION_PARTNER_STATUSES: readonly PartnerStatus[] = [
  'pending', 'active', 'suspended', 'churned',
];

function isRegistrationPartnerStatus(value: string): value is PartnerStatus {
  return REGISTRATION_PARTNER_STATUSES.some((status) => status === value);
}

export const verifyEmailRoutes = new Hono();

function registrationIssuanceError(c: Context, error: unknown): Response | null {
  if (error instanceof AuthBindingRotationRequiredError) {
    installAuthBindingReplacement(c, error.replacement);
    return c.json({
      error: 'Authentication binding refresh required',
      reason: 'binding_refresh',
    }, 428);
  }
  if (
    error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError
  ) {
    return c.json({ error: 'Authentication temporarily unavailable' }, 409);
  }
  return null;
}

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
    // This read-only peek grants and consumes no authority. Pending signup
    // state stays retryable until the PostgreSQL authority transaction commits.
    const tokenHash = sha256Hex(token);
    const pending = await peekPendingRegistration(tokenHash);
    if (pending) {
      return finalizePendingRegistration(c, Object.freeze({ ...pending }), tokenHash);
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

type CreatedRegistration = Awaited<ReturnType<typeof createPartner>>;

interface RegistrationFacts {
  created: CreatedRegistration;
  partnerRow: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: PartnerStatus;
    trustState: PartnerTrustState;
    settings: unknown;
  };
  userRow: {
    id: string;
    email: string;
    name: string;
    mfaEnabled: boolean;
  };
  roleRow: { forceMfa: boolean };
  authEpoch: number;
  mfaEpoch: number;
  mfaEnrollmentRequired: boolean;
  mfaSatisfied: boolean;
}

type RegistrationCommit =
  | Readonly<{ kind: 'sign_in' }>
  | Readonly<{ kind: 'created_guarded'; facts: RegistrationFacts; issued: AuthorizedUserSession }>
  | Readonly<{ kind: 'created_legacy'; facts: RegistrationFacts }>;

async function createRegistrationAccount(
  tx: AuthLifecycleTransaction,
  rec: PendingRegistration,
): Promise<RegistrationFacts | null> {
  const normalizedEmail = rec.email.toLowerCase().trim();
  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  if (existing) return null;

  const created = await createPartner({
    orgName: rec.companyName,
    adminEmail: rec.email,
    adminName: rec.name,
    passwordHash: rec.passwordHash,
    origin: { mcp: false, ip: rec.signupIp, userAgent: rec.signupUserAgent },
    status: rec.hostedExpectation ? 'pending' : 'active',
  }, { tx });

  const [partnerRow] = await tx
    .select({
      id: partners.id,
      name: partners.name,
      slug: partners.slug,
      plan: partners.plan,
      status: partners.status,
      trustState: partners.trustState,
      settings: partners.settings,
    })
    .from(partners)
    .where(eq(partners.id, created.partnerId))
    .limit(1);
  const [userRow] = await tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      mfaEnabled: users.mfaEnabled,
    })
    .from(users)
    .where(eq(users.id, created.adminUserId))
    .limit(1);
  const [roleRow] = await tx
    .select({ forceMfa: roles.forceMfa })
    .from(roles)
    .where(eq(roles.id, created.adminRoleId))
    .limit(1);
  if (!partnerRow || !userRow || !roleRow) {
    throw new Error('Partner, user or admin-role row missing after createPartner');
  }

  const now = new Date();
  await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, created.adminUserId));
  await tx
    .update(partners)
    .set({ emailVerifiedAt: now, updatedAt: now })
    .where(eq(partners.id, created.partnerId));
  const epochs = await advanceUserEpochs(tx, created.adminUserId, { auth: true });

  const partnerSettings = (partnerRow.settings ?? {}) as Record<string, unknown>;
  const policy = combineMfaPolicyFacts({
    roleForceMfa: roleRow.forceMfa === true,
    security: partnerSettings.security as MfaSecuritySettings | undefined,
    failClosed: true,
  });
  const mfaEnrollmentRequired = ENABLE_2FA && !userRow.mfaEnabled && policy.required;
  const mfaSatisfied = !ENABLE_2FA || (!userRow.mfaEnabled && !policy.required);

  return {
    created,
    partnerRow,
    userRow,
    roleRow,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    mfaEnrollmentRequired,
    mfaSatisfied,
  };
}

async function durableRegistrationUserExists(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();
  const [existing] = await withSystemDbAccessContext(() => db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1));
  return existing !== undefined;
}

async function consumePendingRegistrationAfterCommit(tokenHash: string): Promise<void> {
  try {
    await consumePendingRegistration(tokenHash);
  } catch (error) {
    console.error('[verify-email] pending-registration delete failed after durable commit', {
      tokenHash: tokenHash.slice(0, 12),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function registrationIdentity(facts: RegistrationFacts): UserSessionIdentity {
  return {
    userId: facts.created.adminUserId,
    email: facts.userRow.email,
    roleId: facts.created.adminRoleId,
    orgId: facts.created.orgId,
    partnerId: facts.created.partnerId,
    scope: 'partner',
    mfa: facts.mfaSatisfied,
  };
}

async function applyGuardedRegistrationStatusChange(
  c: Context,
  facts: RegistrationFacts,
  status: PartnerStatus,
): Promise<AuthorizedUserSession> {
  let capability: AuthIssuanceCapability | null = null;
  try {
    capability = await beginAuthIssuance(requestAuthBinding(c));
    const guardedCapability = capability;
    const issued = await finishAuthIssuance(guardedCapability, async (tx) => {
      let epochs: { authEpoch: number; mfaEpoch: number };
      if (facts.partnerRow.status === 'pending' && status === 'active') {
        const activation = await activatePendingPartnerAndInvalidateSessions(
          tx,
          facts.created.partnerId,
        );
        const adminEpochs = activation.epochs.find(
          (entry) => entry.userId === facts.created.adminUserId,
        );
        if (!activation.activated || !adminEpochs) {
          throw new AuthIssuanceCapabilityError();
        }
        epochs = adminEpochs;
      } else {
        const next = await advanceUserEpochs(tx, facts.created.adminUserId, { auth: true });
        await lockActiveRefreshFamiliesForUsers(tx, [facts.created.adminUserId]);
        await revokeAllRefreshFamilies(tx, facts.created.adminUserId, 'registration-status-changed');
        const updated = await tx
          .update(partners)
          .set({ status, updatedAt: new Date() })
          .where(eq(partners.id, facts.created.partnerId))
          .returning({ id: partners.id });
        if (updated.length !== 1) throw new AuthIssuanceCapabilityError();
        epochs = { authEpoch: next.authEpoch, mfaEpoch: next.mfaEpoch };
      }

      return issueUserSession(registrationIdentity(facts), {
        tx,
        capability: guardedCapability,
        expectedEpochs: epochs,
      });
    });
    await bindIssuedUserSession(issued);
    return issued;
  } catch (error) {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
    throw error;
  }
}

/**
 * Email-first signup finalization. The immutable Redis snapshot is read before
 * admission, but account authority is created only inside the browser-guarded
 * PostgreSQL transaction. Redis is consumed only after that commit.
 */
async function finalizePendingRegistration(
  c: Context,
  rec: PendingRegistration,
  tokenHash: string,
): Promise<Response> {
  if (!ENABLE_REGISTRATION || isHosted() !== rec.hostedExpectation) {
    writeAuthAudit(c, {
      action: 'auth.email_verify_failed',
      result: 'failure',
      reason: 'registration_policy_changed',
      email: rec.email,
    });
    return c.json({ error: 'Invalid or expired verification link' }, 400);
  }

  const transitionV1 = isAuthTransitionV1Request(c);
  if (!transitionV1 && authBrowserTransitionsEnforced()) {
    return authClientUpgradeRequiredResponse(c);
  }

  let committed: RegistrationCommit;
  let capability: AuthIssuanceCapability | null = null;
  try {
    if (transitionV1) {
      capability = await beginAuthIssuance(requestAuthBinding(c));
      const guardedCapability = capability;
      committed = await finishAuthIssuance(guardedCapability, async (tx) => {
        const facts = await createRegistrationAccount(tx, rec);
        if (!facts) return { kind: 'sign_in' as const };
        const issued = await issueUserSession(registrationIdentity(facts), {
          tx,
          capability: guardedCapability,
          expectedEpochs: { authEpoch: facts.authEpoch, mfaEpoch: facts.mfaEpoch },
        });
        return { kind: 'created_guarded' as const, facts, issued };
      });
    } else {
      const facts = await withSystemDbAccessContext(() =>
        db.transaction((tx) => createRegistrationAccount(tx, rec)));
      if (!facts) {
        committed = { kind: 'sign_in' };
      } else {
        committed = { kind: 'created_legacy', facts };
      }
    }
  } catch (error) {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
    if (isPgUniqueViolation(error)) {
      let durableWinner = false;
      try {
        durableWinner = await durableRegistrationUserExists(rec.email);
      } catch (lookupError) {
        console.error('[verify-email] failed to resolve durable registration winner', {
          error: lookupError instanceof Error ? lookupError.message : String(lookupError),
        });
      }
      if (durableWinner) {
        await consumePendingRegistrationAfterCommit(tokenHash);
        writeAuthAudit(c, {
          action: 'auth.email_verified',
          result: 'denied',
          reason: 'already_registered',
          email: rec.email,
        });
        return c.json({ verified: false, status: 'sign_in' as const }, 200);
      }
      return c.json({ error: 'Authentication temporarily unavailable' }, 409);
    }
    const response = registrationIssuanceError(c, error);
    if (response) return response;
    console.error('[verify-email] pending-registration durable finalization failed', error);
    captureException(error, c);
    return c.json({ error: 'Registration failed. Please try again.' }, 500);
  }

  await consumePendingRegistrationAfterCommit(tokenHash);
  if (committed.kind === 'sign_in') {
    writeAuthAudit(c, {
      action: 'auth.email_verified',
      result: 'denied',
      reason: 'already_registered',
      email: rec.email,
    });
    return c.json({ verified: false, status: 'sign_in' as const }, 200);
  }

  const { facts } = committed;
  if (rec.signupIp && partnerTrustMode() !== 'off') {
    void enqueueIpClassify({
      kind: 'partner',
      partnerId: facts.created.partnerId,
      ip: rec.signupIp,
    }).catch((err) => {
      console.warn('[VerifyEmail] Failed to queue signup IP classification:', err instanceof Error ? err.message : err);
    });
  }
  if (committed.kind === 'created_guarded') {
    await bindIssuedUserSession(committed.issued);
  }

  try {
    if (facts.partnerRow.trustState === 'probation') {
      try {
        await createAuditLog({
          orgId: null,
          actorType: 'system',
          actorId: ANONYMOUS_ACTOR_ID,
          action: 'partner.trust.probation',
          resourceType: 'partner',
          resourceId: facts.created.partnerId,
          result: 'success',
          details: { reason: 'signup', from: null, to: 'probation' },
        });
      } catch (auditErr) {
        console.error('[VerifyEmail] trust probation audit write failed', {
          partnerId: facts.created.partnerId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
    }

    // External webhook work is deliberately post-commit: no transition, user,
    // family, or tenant lock is held while another service is contacted.
    const hookResponse = await dispatchHook('registration', facts.created.partnerId, {
      email: facts.userRow.email,
      partnerName: facts.partnerRow.name,
      plan: facts.partnerRow.plan,
    });

    let effectiveStatus: PartnerStatus = facts.partnerRow.status;

    // The status override and the inactive-screen banner are INDEPENDENT
    // contributions to one UPDATE. They used to be one nested block, gated on
    // `hookResponse.status !== partnerRow.status` — which silently dropped the
    // banner for every hosted signup from 2026-05-01 (#542) onward: that commit
    // made the API create hosted partners `pending` itself, and breeze-billing's
    // hook also returns `pending`, so the statuses matched and the branch never
    // ran. The banner is the ONLY payment presentation on the web login path
    // (`stores/auth.ts` → /account/inactive → statusActionUrl), so 144 partners
    // sat on "Your account is being set up. Please check back shortly." with no
    // way to pay. Keep these two concerns separate.
    const updateSet: Record<string, unknown> = {};

    const msgSettings: Record<string, string> = {};
    if (hookResponse?.message) msgSettings.statusMessage = hookResponse.message;
    if (hookResponse?.actionUrl && isSafeHookActionUrl(hookResponse.actionUrl)) {
      msgSettings.statusActionUrl = hookResponse.actionUrl;
    } else if (hookResponse?.actionUrl) {
      console.error(
          `[verify-email] Hook returned a non-http(s) actionUrl for partner ${facts.created.partnerId}; dropping it`,
      );
    }
    if (hookResponse?.actionLabel) msgSettings.statusActionLabel = hookResponse.actionLabel;
    if (Object.keys(msgSettings).length > 0) {
      updateSet.settings = sql`COALESCE(${partners.settings}, '{}'::jsonb) || ${JSON.stringify(msgSettings)}::jsonb`;
    }

    let statusChange: PartnerStatus | null = null;
    if (hookResponse?.status && hookResponse.status !== facts.partnerRow.status) {
      if (!isRegistrationPartnerStatus(hookResponse.status)) {
        console.error(
          `[verify-email] Hook returned invalid status '${hookResponse.status}' for partner ${facts.created.partnerId}; ignoring`,
        );
      } else {
        statusChange = hookResponse.status;
      }
    }

    if (statusChange && committed.kind === 'created_guarded') {
      const issued = await applyGuardedRegistrationStatusChange(c, facts, statusChange);
      committed = { kind: 'created_guarded', facts, issued };
      effectiveStatus = statusChange;
    }

    if (statusChange && committed.kind === 'created_legacy') {
      if (facts.partnerRow.status === 'pending' && statusChange === 'active') {
        const activation = await withSystemDbAccessContext(() => db.transaction((tx) =>
          activatePendingPartnerAndInvalidateSessions(tx, facts.created.partnerId)));
        const adminEpochs = activation.epochs.find(
          (entry) => entry.userId === facts.created.adminUserId,
        );
        if (!activation.activated || !adminEpochs) {
          throw new AuthIssuanceCapabilityError();
        }
        effectiveStatus = statusChange;
      } else {
        updateSet.status = statusChange;
      }
    }

    if (Object.keys(updateSet).length > 0) {
      updateSet.updatedAt = new Date();
      try {
        await withSystemDbAccessContext(() =>
          db.update(partners).set(updateSet).where(eq(partners.id, facts.created.partnerId)),
        );
        if (
          statusChange
          && committed.kind === 'created_legacy'
          && 'status' in updateSet
        ) effectiveStatus = statusChange;
      } catch (statusErr) {
        console.error('[verify-email] hook status/banner update failed', {
          partnerId: facts.created.partnerId,
          error: statusErr instanceof Error ? statusErr.message : String(statusErr),
        });
        writeAuditEvent(c, {
          orgId: null,
          actorType: 'system',
          action: 'register-partner.hook-status-update-failed',
          resourceType: 'partner',
          resourceId: facts.created.partnerId,
          resourceName: facts.partnerRow.name,
          details: {
            fromStatus: facts.partnerRow.status,
            // null when this UPDATE carried only banner fields — do not imply a
            // status transition that was never attempted.
            toStatus: 'status' in updateSet ? statusChange : null,
            bannerKeys: Object.keys(msgSettings),
          },
          result: 'failure',
          errorMessage: statusErr instanceof Error ? statusErr.message : String(statusErr),
        });
      }
    }

    // Only allow same-origin relative redirects from hooks (open-redirect
    // guard). A bare leading-slash test is NOT sufficient: `//evil.com` is
    // protocol-relative and navigates off-origin, and browsers normalize
    // `/\evil.com` into the same thing. Mirrors apps/web's getSafeNext.
    const redirectUrl = isSafeRelativeRedirect(hookResponse?.redirectUrl)
      ? hookResponse!.redirectUrl
      : undefined;

    const responseBase = {
      verified: true,
      user: { id: facts.created.adminUserId, email: facts.userRow.email, name: facts.userRow.name, mfaEnabled: false },
      partner: { id: facts.created.partnerId, name: facts.partnerRow.name, slug: facts.partnerRow.slug, status: effectiveStatus },
      mfaRequired: false,
      mfaEnrollmentRequired: facts.mfaEnrollmentRequired,
      enrollUrl: facts.mfaEnrollmentRequired ? '/auth/mfa/setup' : undefined,
      ...(redirectUrl ? { redirectUrl } : {}),
    };
    if (committed.kind === 'created_guarded') {
      writeAuthAudit(c, {
        action: 'auth.email_verified',
        result: 'success',
        userId: facts.created.adminUserId,
        email: facts.userRow.email,
        details: { partnerId: facts.created.partnerId, registration: true },
      });
      installAuthorizedUserSessionCookies(c, committed.issued);
      return c.json({
        ...responseBase,
        tokens: toPublicTokens(committed.issued),
      });
    }

    recordAuthTransitionLegacyIssuer('registration', 'web');
    const issued = await issueUserSessionLegacyDuringTransition(registrationIdentity(facts));
    writeAuthAudit(c, {
      action: 'auth.email_verified',
      result: 'success',
      userId: facts.created.adminUserId,
      email: facts.userRow.email,
      details: { partnerId: facts.created.partnerId, registration: true },
    });
    installLegacyUserSessionCookiesDuringTransition(c, issued);
    return c.json({
      ...responseBase,
      tokens: toPublicTokens(issued),
    });
  } catch (err) {
    const response = registrationIssuanceError(c, err);
    if (response) return response;
    // Account/session authority is already committed. Hook and response-shaping
    // failures are observable, but never re-park the Redis authority.
    console.error('[verify-email] pending-registration finalize failed after createPartner', {
      partnerId: facts.created.partnerId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, c);
    return c.json({ error: 'Registration failed. Please try again.' }, 500);
  }
}
