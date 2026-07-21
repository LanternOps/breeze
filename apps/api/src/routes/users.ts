import { Hono } from 'hono';
import type { SupportedLocale } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { and, eq, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { nanoid } from 'nanoid';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users, partnerUsers, organizationUsers, roles, organizations, partners } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import {
  MAX_AVATAR_SIZE_BYTES,
  deleteAvatar,
  readAvatarBuffer,
  sniffImageMime,
  statAvatar,
  weakEtagFor,
  writeAvatar,
} from '../services/avatarStorage';
import {
  clearPermissionCache,
  getUserPermissions,
  PERMISSIONS
} from '../services/permissions';
import {
  getScopeContext,
  getScopedRole,
  validateAssignableRole,
  type ScopeContext,
} from '../services/roleAssignment';
import { createAuditLogAsync } from '../services/auditService';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { getEmailService } from '../services/email';
import { captureException } from '../services/sentry';
import { getRedis } from '../services';
import { INVITE_TOKEN_TTL_SECONDS } from './auth/schemas';
import { enforceExistingFactorStepUp, hashInviteToken, inviteRedisKey, inviteUserRedisKey, requireCurrentPasswordStepUp, resolveUserAuditOrgId, userIsMfaProtected, userRequiresSetup } from './auth/helpers';
import { isPasswordAuthDisabledBySso } from './auth/ssoPolicy';
import { terminateUserRemoteSessions, TEARDOWN_FAILED } from '../services/remoteSessionTeardown';
import { advanceUserEpochs, revokeAllRefreshFamilies, runPostCommitCleanup, type Tx } from '../services/authLifecycle';
import { invalidateMfaAssuranceAfterFactorChange } from '../services/mfaAssurance';
import { getEffectiveMfaPolicy } from '../services/mfaPolicy';
import { requestPendingEmailChange } from '../services/pendingEmail';

export const userRoutes = new Hono();
const supportedLocales = ['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const satisfies readonly SupportedLocale[];

userRoutes.use('*', authMiddleware);
userRoutes.use('*', async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.scope !== 'partner') {
    await next();
    return;
  }

  // Self-service routes (own profile + own/displayed avatar) must stay accessible
  // to EVERY partner user regardless of org-access level. This gate governs
  // partner-wide user MANAGEMENT only — without this exemption a 'selected'/'none'
  // partner admin would be 403'd on GET/PATCH /me and the top-bar avatar
  // (GET /:id/avatar runs its own scope check in the handler).
  const path = c.req.path;
  const isSelfServiceRoute =
    /\/me(\/avatar)?$/.test(path) ||
    (c.req.method === 'GET' && /\/avatar$/.test(path));
  if (isSelfServiceRoute) {
    await next();
    return;
  }

  if (!auth.partnerId) {
    throw new HTTPException(403, { message: 'Partner context required' });
  }

  if (!Array.isArray(auth.accessibleOrgIds)) {
    await next();
    return;
  }

  // Partner-wide user management requires a FULL-access partner membership.
  // Gate directly on partnerUsers.orgAccess === 'all' — the same field the
  // middleware uses to compute accessibleOrgIds (auth.ts). Do NOT infer this by
  // comparing accessibleOrgIds against the partner's org list: accessibleOrgIds
  // is filtered to active/trial, non-deleted orgs, so a full-access admin of a
  // partner that has any suspended/soft-deleted org (or zero orgs yet) would be
  // false-denied, while the org-list read under request RLS is itself narrowed
  // (the RLS-vacuous trap). orgAccess is the authoritative, status-independent
  // signal that distinguishes 'all' from the 'selected'/'none' escalation case.
  const [membership] = await db
    .select({ orgAccess: partnerUsers.orgAccess })
    .from(partnerUsers)
    .where(
      and(
        eq(partnerUsers.userId, auth.user.id),
        eq(partnerUsers.partnerId, auth.partnerId)
      )
    )
    .limit(1);

  if (membership?.orgAccess !== 'all') {
    throw new HTTPException(403, { message: 'Full partner organization access required' });
  }

  await next();
});

const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  roleId: z.string().guid(),
  orgAccess: z.enum(['all', 'selected', 'none']).optional(),
  orgIds: z.array(z.string().guid()).optional(),
  siteIds: z.array(z.string().guid()).optional(),
  deviceGroupIds: z.array(z.string().guid()).optional()
});

const resendInviteSchema = z.object({
  userId: z.string().guid()
});

// .strict() so unknown keys surface as 400, not silently dropped. Role is not
// updatable via this endpoint — POST /users/:id/role writes the join-table row.
const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional()
}).strict();

const assignRoleSchema = z.object({
  roleId: z.string().guid()
});

async function getScopedUser(userId: string, scopeContext: ScopeContext) {
  if (scopeContext.scope === 'partner') {
    const [record] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        roleId: roles.id,
        roleName: roles.name,
        orgAccess: partnerUsers.orgAccess,
        orgIds: partnerUsers.orgIds
      })
      .from(partnerUsers)
      .innerJoin(users, eq(partnerUsers.userId, users.id))
      .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
      .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), eq(partnerUsers.userId, userId)))
      .limit(1);

    return record || null;
  }

  const [record] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      roleId: roles.id,
      roleName: roles.name,
      siteIds: organizationUsers.siteIds,
      deviceGroupIds: organizationUsers.deviceGroupIds
    })
    .from(organizationUsers)
    .innerJoin(users, eq(organizationUsers.userId, users.id))
    .innerJoin(roles, eq(organizationUsers.roleId, roles.id))
    .where(and(eq(organizationUsers.orgId, scopeContext.orgId), eq(organizationUsers.userId, userId)))
    .limit(1);

  return record || null;
}

function resolveAuditOrgId(auth: { orgId: string | null }, scopeContext: ScopeContext): string | null {
  if (scopeContext.scope === 'organization') {
    return scopeContext.orgId;
  }
  return auth.orgId ?? null;
}

function buildInviteUrl(inviteToken: string): string {
  const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
  return `${appBaseUrl}/accept-invite?token=${encodeURIComponent(inviteToken)}`;
}

async function generateInviteToken(userId: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[UsersRoute] Redis unavailable; cannot generate invite token');
    return null;
  }

  try {
    // Revoke any existing invite token for this user
    const existingHash = await redis.get(inviteUserRedisKey(userId));
    if (existingHash) {
      await redis.del(inviteRedisKey(existingHash));
    }

    const inviteToken = nanoid(48);
    const tokenHash = hashInviteToken(inviteToken);

    await redis.setex(inviteRedisKey(tokenHash), INVITE_TOKEN_TTL_SECONDS, userId);
    await redis.setex(inviteUserRedisKey(userId), INVITE_TOKEN_TTL_SECONDS, tokenHash);

    return inviteToken;
  } catch (err) {
    console.error('[UsersRoute] Failed to store invite token in Redis:', err);
    return null;
  }
}

async function resolveInviteOrgName(scopeContext: ScopeContext): Promise<string | undefined> {
  if (scopeContext.scope !== 'organization') {
    return undefined;
  }

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, scopeContext.orgId))
    .limit(1);

  return org?.name || undefined;
}

async function sendInviteEmail(
  scopeContext: ScopeContext,
  invitee: { email: string; name: string },
  inviter: { name?: string; email?: string },
  inviteToken: string
): Promise<boolean> {
  const emailService = getEmailService();
  if (!emailService) {
    console.warn('[UsersRoute] Email service not configured; invite email was not sent');
    return false;
  }

  const orgName = await resolveInviteOrgName(scopeContext);
  const inviterName = inviter.name || inviter.email;

  try {
    await emailService.sendInvite({
      to: invitee.email,
      name: invitee.name,
      inviterName,
      orgName,
      inviteUrl: buildInviteUrl(inviteToken)
    });
    return true;
  } catch (error) {
    console.error(`[UsersRoute] Failed to send invite email to ${invitee.email}:`, error);
    return false;
  }
}

async function generateAndDeliverInvite(
  userId: string,
  scopeContext: ScopeContext,
  invitee: { email: string; name: string },
  inviter: { name?: string; email?: string }
): Promise<{ inviteEmailSent: boolean; inviteUrl?: string; warning?: string }> {
  const inviteToken = await generateInviteToken(userId);
  if (!inviteToken) {
    return {
      inviteEmailSent: false,
      warning: 'Invite token could not be generated. Please resend the invite later.',
    };
  }

  const inviteEmailSent = await sendInviteEmail(scopeContext, invitee, inviter, inviteToken);

  return {
    inviteEmailSent,
    inviteUrl: inviteEmailSent ? undefined : buildInviteUrl(inviteToken),
  };
}

function writeUserAudit(
  c: any,
  auth: { orgId: string | null; user: { id: string; email?: string; name?: string } },
  scopeContext: ScopeContext | null,
  event: {
    action: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
  }
): void {
  const orgId = scopeContext ? resolveAuditOrgId(auth, scopeContext) : auth.orgId;

  createAuditLogAsync({
    orgId: orgId ?? undefined,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: event.action,
    resourceType: 'user',
    resourceId: event.resourceId,
    resourceName: event.resourceName,
    details: event.details,
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });
}

// --- Users ---

// Get current user's profile (no special permissions needed - just auth)
userRoutes.get('/me', async (c) => {
  const auth = c.get('auth');

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      status: users.status,
      mfaEnabled: users.mfaEnabled,
      // #2707: lets the profile UI pick the approver-register re-auth tier
      // (passkey → TOTP code → password) without a second endpoint.
      mfaMethod: users.mfaMethod,
      // Exposed so the web sidebar can hide platform-admin-only nav (e.g.
      // account-deletion-requests) and skip its badge fetch — otherwise that
      // fetch 403s ("platform admin access required") on every page load for
      // ordinary partner/org users and spams the console.
      isPlatformAdmin: users.isPlatformAdmin,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
      setupCompletedAt: users.setupCompletedAt,
      passwordChangedAt: users.passwordChangedAt,
      preferences: users.preferences
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const requiresSetup = userRequiresSetup(user);

  // The partner default is derived only from the authenticated tenant context.
  // Do not accept a partner id from query/body input here: doing so would let a
  // caller probe another tenant's settings while loading their own profile.
  //
  // Read under a SYSTEM context: org-scoped sessions get accessiblePartnerIds
  // = [] (computeAccessiblePartnerIds in middleware/auth.ts), so the ambient
  // request context's `breeze_has_partner_access` RLS policy would filter this
  // row out and silently leave partnerDefaultLocale null for the majority of
  // logins. auth.partnerId comes from the verified JWT, never client input, so
  // escalating this single hard-scoped-by-id lookup is safe.
  let partnerDefaultLocale: SupportedLocale | null = null;
  if (auth.partnerId) {
    const partnerId = auth.partnerId;
    const [partner] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ settings: partners.settings })
          .from(partners)
          .where(eq(partners.id, partnerId))
          .limit(1)
      )
    );
    const language = (partner?.settings as { language?: unknown } | null | undefined)?.language;
    partnerDefaultLocale =
      typeof language === 'string'
      && (supportedLocales as readonly string[]).includes(language)
        ? language as SupportedLocale
        : null;
  }

  // Surface the user's effective permission grants so the web app can hide nav
  // items and action buttons the user can't use. This is UX only — every route
  // still enforces requirePermission server-side.
  //
  // Contract: getUserPermissions returns null ONLY for "no resolvable role"
  // (no membership row / null roleId) — a genuine zero-grant user, for whom
  // `?? []` is correct fail-closed behavior. It must NEVER swallow a transient
  // cache/DB fault into null: those throw, so /me 500s and the client keeps its
  // last-known grants rather than silently blanking every gated control.
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined
  });

  return c.json({
    ...user,
    partnerId: auth.partnerId,
    orgId: auth.orgId,
    scope: auth.scope,
    partnerDefaultLocale,
    permissions: userPerms?.permissions ?? [],
    requiresSetup
  });
});

// Update current user's profile.
// NOTE: `avatarUrl` is intentionally NOT part of this schema. Avatars are
// managed exclusively through POST/DELETE /users/me/avatar (file upload). The
// strict() refinement causes any client still sending avatarUrl to get a 400,
// which is what we want — silent drop would mask client bugs.
const updateMeSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    email: z.string().email().max(255).optional(),
    preferences: z
      .union([
        z.record(z.string().max(64), z.unknown()),
        z.null(),
      ])
      .optional(),
    // Account-takeover step-up for the email-change path. NEVER persisted and
    // excluded from the audit changedFields — it is verified, then dropped.
    currentPassword: z.string().optional(),
    // SR2-18 recovery-grade step-up: an MFA-protected account must additionally
    // present a FRESH existing-factor step-up grant (minted seconds ago by
    // POST /auth/mfa/step-up). NEVER persisted, excluded from audit
    // changedFields — it is consumed by enforceExistingFactorStepUp, then dropped.
    stepUpGrantId: z.string().uuid().optional(),
  })
  .strict();

function isPreferenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePreferenceEnum(
  prefs: Record<string, unknown>,
  key: string,
  validValues: readonly string[],
  label: string
): string | null {
  if (!(key in prefs)) return null;
  const value = prefs[key];
  if (typeof value !== 'string' || !validValues.includes(value)) {
    return `Invalid ${key} value. Must be ${label}.`;
  }
  return null;
}

userRoutes.patch('/me', zValidator('json', updateMeSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');

  // Load the caller's own row once: needed to detect a real email change and to
  // choose the right step-up factor (local password vs MFA).
  const [self] = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      preferences: users.preferences,
      // The token minted for the pending address is partner-scoped. users.partner_id
      // is NOT NULL, and an org-scoped session carries auth.partnerId === null, so
      // read the owning partner off the row rather than the token.
      partnerId: users.partnerId
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!self) {
    return c.json({ error: 'User not found' }, 404);
  }

  const updates: { name?: string; email?: string; preferences?: Record<string, unknown>; updatedAt: Date } = {
    updatedAt: new Date()
  };

  // Tracks how identity was re-proven for the email change so the dedicated
  // audit can record it. Stays undefined for non-email changes.
  let stepUpMethod: 'password' | 'mfa' | undefined;
  // The address that owns the account right now — used for the audit detail and
  // the security notification to the OLD (still-authoritative) address.
  let previousEmail: string | undefined;
  // SR2-17: the REQUESTED address, recorded as pending. NOT written to
  // users.email — the live identity does not move until the verification token
  // minted below is redeemed (Task 8).
  let pendingNewEmail: string | undefined;

  if (body.name) {
    updates.name = body.name.slice(0, 255);
  }

  if (body.preferences !== undefined) {
    if (body.preferences !== null && typeof body.preferences === 'object') {
      // Cap serialized size to defend against arbitrarily-large free-form blobs.
      const serialized = JSON.stringify(body.preferences);
      if (serialized.length > 64 * 1024) {
        return c.json({ error: 'preferences payload too large (64KB max)' }, 400);
      }
      const prefs = body.preferences as Record<string, unknown>;
      const validationError =
        validatePreferenceEnum(
          prefs,
          'theme',
          ['light', 'dark', 'system'],
          'light, dark, or system'
        )
        ?? validatePreferenceEnum(
          prefs,
          'density',
          ['comfortable', 'compact', 'dense'],
          'comfortable, compact, or dense'
        )
        ?? validatePreferenceEnum(prefs, 'font', ['breeze', 'system'], 'breeze or system')
        ?? validatePreferenceEnum(prefs, 'timeFormat', ['12h', '24h'], '12h or 24h')
        ?? validatePreferenceEnum(
          prefs,
          'locale',
          supportedLocales,
          'en, pt-BR, es-419, fr-FR, or de-DE'
        );
      if (validationError) {
        return c.json({ error: validationError }, 400);
      }
      const mergedPreferences = {
        ...(isPreferenceRecord(self.preferences) ? self.preferences : {}),
        ...prefs
      };
      const mergedSerialized = JSON.stringify(mergedPreferences);
      if (mergedSerialized.length > 64 * 1024) {
        return c.json({ error: 'preferences payload too large (64KB max)' }, 400);
      }
      updates.preferences = mergedPreferences;
    } else if (body.preferences === null) {
      updates.preferences = undefined;
    }
  }

  if (body.email) {
    const normalizedEmail = body.email.toLowerCase().trim().slice(0, 255);
    // self.email is already normalized in the DB; only step-up + record-pending
    // when the email is genuinely changing. A same-email "change" is a no-op.
    const emailChanging = normalizedEmail !== self.email;

    if (emailChanging) {
      // (a) SSO-enforced org: email is managed at the IdP. Unchanged.
      if (await isPasswordAuthDisabledBySso({ scope: auth.scope, orgId: auth.orgId, partnerId: auth.partnerId })) {
        return c.json({ error: 'Email changes for this organization are managed through your SSO provider.' }, 403);
      }

      // SR2-18: a user parked in mfa_enrollment_required is admitted to
      // /users/me ONLY so they can finish enrolling (isMfaEnrollmentExemptPath
      // in middleware/auth.ts exempts the whole path — the middleware sees the
      // path, not the body). That exemption must NOT let them move the account's
      // RECOVERY ADDRESS: a session stolen before enrollment could otherwise
      // repoint recovery and defeat the whole forced-enrollment gate. The gate
      // lives HERE, in the handler, because narrowing the path exemption would
      // break GET /users/me, which the enrollment UI needs. Fail CLOSED: an
      // unresolvable policy (getEffectiveMfaPolicy throws) denies too.
      const policy = await getEffectiveMfaPolicy({
        scope: auth.scope,
        userId: auth.user.id,
        orgId: auth.orgId,
        partnerId: auth.partnerId,
      });
      if (policy.required && !(await userIsMfaProtected(auth.user.id))) {
        return c.json({ error: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' }, 403);
      }

      // SR2-18: an email change moves the account's recovery surface — the new
      // address can drive /forgot-password and MFA recovery — so it demands the
      // SAME assurance as adding an MFA factor, not less.
      //
      //   (b) local-password user: current password, verified against argon2;
      //   (c) passwordless AND unprotected (SSO-only account with no factor and
      //       no password): there is nothing to step up with → DENY. This must
      //       not fall through to a vacuous mfa=true pass.
      //   then, for any MFA-PROTECTED account: additionally a FRESH existing-
      //       factor step-up grant, bound to the live epochs + this session's
      //       sid. A stale MFA claim on an hours-old token is NOT sufficient.
      if (self.passwordHash) {
        if (!body.currentPassword) {
          return c.json({ error: 'Current password is required to change your email address.' }, 400);
        }
        const stepUp = await requireCurrentPasswordStepUp(c, auth.user.id, body.currentPassword, 'email-change:pwd');
        if (stepUp) return stepUp; // 401 / 429 / 503 Response, or null on success
        stepUpMethod = 'password';
      } else if (!(await userIsMfaProtected(auth.user.id))) {
        return c.json({ error: 'This account cannot change its email address here.' }, 403);
      }

      // enforceExistingFactorStepUp is a NO-OP for an account with no factor
      // (initial-enrollment chicken-and-egg), and a hard 403 for a protected
      // account without a fresh grant. consume: true — single use, terminal.
      const factorStepUp = await enforceExistingFactorStepUp(c, auth, body.stepUpGrantId, { consume: true });
      if (factorStepUp) return factorStepUp;
      if (!stepUpMethod) stepUpMethod = 'mfa';

      // The still-authoritative address (login/reset/SSO still resolve to it)
      // and the requested address. No cross-account uniqueness pre-check runs
      // here: revealing "that address already belongs to someone" is an
      // enumeration oracle (SR2 property 3). pending_email is intentionally NOT
      // unique; a genuine collision fails CLOSED at COMMIT (Task 8) as a 23505
      // against users_email_unique. The response below is uniform whether or not
      // the address is taken.
      previousEmail = self.email;
      pendingNewEmail = normalizedEmail;
    }
  }

  // A same-email PATCH (body.email provided but unchanged) stays a valid 200
  // no-op — the updatedAt-only write below is harmless. Only bail with "No
  // valid updates" when the caller supplied nothing actionable at all.
  if (Object.keys(updates).length === 1 && body.email === undefined) {
    return c.json({ error: 'No valid updates provided' }, 400);
  }

  const returningColumns = {
    id: users.id,
    email: users.email,
    name: users.name,
    avatarUrl: users.avatarUrl,
    status: users.status,
    mfaEnabled: users.mfaEnabled,
    preferences: users.preferences
  };

  // SR2-17: the email is NOT written here. `updates` never carries `email`, so
  // the live identity (login, password reset, CF Access, SSO matching) keeps
  // resolving to the OLD address. A genuine email change becomes a PENDING
  // request below, committed only by the verification click (Task 8). Initiation
  // does NOT advance auth_epoch and does NOT revoke refresh families — the user
  // stays signed in so they can go prove the new address. The email_epoch bump
  // (which invalidates stale verification artifacts) happens inside
  // requestPendingEmailChange; auth_epoch + family revoke move to the commit.
  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, auth.user.id))
    .returning(returningColumns);

  if (!updated) {
    return c.json({ error: 'Failed to update profile' }, 500);
  }

  // SR2-17: record the pending address + mint the email_change verification
  // token. Done AFTER the name/preferences write so a failure here cannot
  // half-apply an unrelated profile edit. Fails closed (throws) on a 0-row
  // pending write — the request 500s rather than reporting a change it never
  // recorded.
  let pendingEmailOut: string | undefined;
  let pendingEmailRequestedAt: Date | undefined;
  if (pendingNewEmail) {
    pendingEmailRequestedAt = new Date();
    const { rawToken } = await requestPendingEmailChange({
      userId: auth.user.id,
      partnerId: self.partnerId,
      newEmail: pendingNewEmail,
    });
    pendingEmailOut = pendingNewEmail;

    const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
    const verificationUrl = `${appBaseUrl}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
    const emailService = getEmailService();
    if (emailService) {
      // To the NEW address: prove you control it.
      await emailService.sendVerificationEmail({ to: pendingNewEmail, name: updated.name ?? undefined, verificationUrl })
        .catch((err: unknown) => { console.error('[users] pending-email verification send failed', err); captureException(err); });
      // To the OLD (still-authoritative) address: a change was REQUESTED. Fires
      // at INITIATION, not only on completion — the owner of the address being
      // abandoned must hear about it while they can still act, not after the swap.
      await emailService.sendEmailChanged({ to: previousEmail!, name: updated.name, newEmail: pendingNewEmail, pending: true })
        .catch((err: unknown) => { console.error('[users] pending-email security notice failed', err); captureException(err); });
    } else {
      console.warn('[users] Email service not configured; pending-email notices were not sent');
    }
  }

  // Every successful self-profile change MUST be audited regardless of caller
  // scope (SOC2 coverage). Partner-scope callers have auth.orgId === null, so
  // resolve an attribution org from the user's membership — mirrors the
  // POST /auth/change-password handler. createAuditLogAsync + persistAuditLog
  // accept a null orgId, so a null resolution still produces an audit row.
  const auditOrgId = auth.orgId ?? await resolveUserAuditOrgId(auth.user.id);
  createAuditLogAsync({
    orgId: auditOrgId,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'user.profile.update',
    resourceType: 'user',
    resourceId: updated.id,
    resourceName: updated.name,
    details: {
      // Only fields actually written to the row. The pending email is NOT a
      // committed field change, so it is reported by the dedicated requested
      // audit below, never here.
      changedFields: Object.keys(updates).filter((key) => key !== 'updatedAt')
    },
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });

  // Dedicated email-change-REQUESTED audit. Only fires on a genuine,
  // step-up-cleared pending change (previousEmail set). Nothing is revoked at
  // initiation, so the revocation-outcome fields (#2428) move to Task 8's
  // commit audit — they are deliberately absent here.
  if (previousEmail !== undefined) {
    createAuditLogAsync({
      orgId: auditOrgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'user.email.change.requested',
      resourceType: 'user',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        previousEmail,
        pendingEmail: pendingNewEmail,
        stepUp: stepUpMethod
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success'
    });
  }

  return c.json({
    ...updated,
    // SR2-17: the returned email is the OLD (unchanged) address. The requested
    // address surfaces separately as pendingEmail so the UI shows a
    // "confirm your new address" state rather than optimistically swapping.
    pendingEmail: pendingEmailOut,
    pendingEmailRequestedAt,
    verificationSent: !!pendingEmailOut
  });
});

// --- Avatars ---
//
// POST /users/me/avatar     multipart upload of png/jpeg/webp, 5 MB max
// GET  /users/:id/avatar    serve the bytes (auth required)
// DELETE /users/me/avatar   clear the bytes + users.avatar_url
//
// Storage: a `bytea` blob on the user's own row (users.avatar_data), in the DB
// — no filesystem volume dependency (#1059). Magic-byte verification is
// required because we don't trust the browser-supplied Content-Type.

const ALLOWED_AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

userRoutes.post(
  '/me/avatar',
  bodyLimit({
    maxSize: MAX_AVATAR_SIZE_BYTES + 64 * 1024, // small slack for multipart overhead
    onError: (c) => c.json({ error: 'Avatar file too large (max 5 MB)' }, 413),
  }),
  async (c) => {
    const auth = c.get('auth');
    const userId = auth.user.id;

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: 'Invalid multipart body' }, 400);
    }

    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: 'file field is required' }, 400);
    }

    if (file.size === 0) {
      return c.json({ error: 'file is empty' }, 400);
    }

    if (file.size > MAX_AVATAR_SIZE_BYTES) {
      return c.json({ error: 'Avatar file too large (max 5 MB)' }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const sniffedMime = sniffImageMime(buffer);
    if (!sniffedMime) {
      return c.json(
        { error: 'Unsupported image format. Allowed: PNG, JPEG, WebP.' },
        415
      );
    }

    // Defense in depth: if a Content-Type was supplied, it must agree with the
    // sniffed mime. (Clients are allowed to omit it.)
    const claimedMime = (file.type || '').toLowerCase();
    if (claimedMime && claimedMime !== sniffedMime && ALLOWED_AVATAR_MIMES.has(claimedMime)) {
      return c.json(
        { error: 'Content-Type does not match file contents' },
        400
      );
    }

    // avatar_url is set inside writeAvatar (single UPDATE) — no follow-up
    // users update here.
    let written;
    try {
      written = await writeAvatar(userId, sniffedMime, buffer);
    } catch (err) {
      // This catch runs before app.onError, which would otherwise be the only
      // Sentry reporter — capture explicitly or storage failures go dark
      // (how the original EACCES bug stayed invisible).
      console.error(`[users/avatar] failed to write avatar (user ${userId}, ${buffer.length} bytes):`, err);
      captureException(err, c);
      return c.json({ error: 'Failed to store avatar' }, 500);
    }

    if (!written) {
      // Own row missing or invisible under RLS — either way an anomaly for an
      // authenticated caller; log it so the 500 is traceable.
      const err = new Error(`[users/avatar] write matched no row for authenticated user ${userId}`);
      console.error(err.message);
      captureException(err, c);
      return c.json({ error: 'Failed to update profile' }, 500);
    }

    createAuditLogAsync({
      orgId: auth.orgId || undefined,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'user.avatar.upload',
      resourceType: 'user',
      resourceId: userId,
      resourceName: auth.user.name,
      details: {
        mime: sniffedMime,
        size: written.size,
        ext: written.ext,
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success'
    });

    return c.json({
      avatarUrl: written.avatarUrl,
      size: written.size,
      mime: sniffedMime,
      updatedAt: written.updatedAt
    });
  }
);

userRoutes.delete('/me/avatar', async (c) => {
  const auth = c.get('auth');
  const userId = auth.user.id;

  const cleared = await deleteAvatar(userId);
  if (!cleared) {
    // Own row missing or invisible under RLS — anomaly for an authenticated
    // caller; log it so the 500 is traceable.
    const err = new Error(`[users/avatar] delete matched no row for authenticated user ${userId}`);
    console.error(err.message);
    captureException(err, c);
    return c.json({ error: 'Failed to clear avatar' }, 500);
  }

  createAuditLogAsync({
    orgId: auth.orgId || undefined,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'user.avatar.delete',
    resourceType: 'user',
    resourceId: userId,
    resourceName: auth.user.name,
    details: {},
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });

  return c.json({ avatarUrl: null });
});

// Serve a user's avatar. Authorization mirrors GET /:id: a caller may always
// read their OWN avatar (the top bar shows it without USERS_READ), but reading
// another user's avatar requires that user to be resolvable within the caller's
// tenant scope. Without this, any authenticated user could fetch any other
// user's avatar across partners/orgs — the `*` partner-scope middleware only
// gates full-org partner reads, not per-id reads (Todd's #1059 review).
userRoutes.get('/:id/avatar', async (c) => {
  const auth = c.get('auth');
  const userId = c.req.param('id')!;

  // Basic shape check — userId comes from the URL and is used as a DB lookup
  // key (parameterized, so no injection risk); rejecting obviously bogus values
  // up-front avoids confusing errors.
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    return c.json({ error: 'Invalid user id' }, 400);
  }

  // Cross-tenant guard. Own avatar is always allowed; any other id must resolve
  // within the caller's tenant scope (same resolution path as GET /:id). The
  // failure returns the same 404 as a missing avatar so the route never reveals
  // which user ids exist in other tenants.
  if (userId !== auth.user.id) {
    const record = await getScopedUser(userId, getScopeContext(auth));
    if (!record) {
      return c.json({ error: 'No avatar' }, 404);
    }
  }

  const stat = await statAvatar(userId);
  if (!stat) {
    return c.json({ error: 'No avatar' }, 404);
  }

  const etag = weakEtagFor(stat.size, stat.mtimeMs);
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, max-age=300');
    return c.body(null, 304);
  }

  // Avatars are capped at MAX_AVATAR_SIZE_BYTES, so buffering is bounded and
  // Content-Length is exact.
  const opened = await readAvatarBuffer(userId);
  if (!opened) {
    // statAvatar passed just above, so a null here is a delete race (or
    // corrupted avatar_mime — logged inside readAvatarBuffer), not "no
    // avatar" — surface as 500 rather than 404. A genuine DB error throws
    // and lands in app.onError, never this branch.
    console.error(`[users/avatar] read returned null after successful stat (user ${userId})`);
    return c.json({ error: 'Failed to read avatar' }, 500);
  }

  // Copy into a plain Uint8Array — Node's Buffer generic isn't accepted as a
  // BodyInit by the DOM lib types; the copy is bounded by the 5 MB cap.
  return new Response(new Uint8Array(opened.buffer), {
    status: 200,
    headers: {
      'Content-Type': opened.mime,
      'Content-Length': String(opened.size),
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
    },
  });
});

userRoutes.get(
  '/',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);

    if (scopeContext.scope === 'partner') {
      const data = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          status: users.status,
          lastLoginAt: users.lastLoginAt,
          mfaEnabled: users.mfaEnabled,
          roleId: roles.id,
          roleName: roles.name,
          orgAccess: partnerUsers.orgAccess,
          orgIds: partnerUsers.orgIds
        })
        .from(partnerUsers)
        .innerJoin(users, eq(partnerUsers.userId, users.id))
        .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
        .where(eq(partnerUsers.partnerId, scopeContext.partnerId));

      return c.json({ data });
    }

    const data = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        mfaEnabled: users.mfaEnabled,
        roleId: roles.id,
        roleName: roles.name,
        siteIds: organizationUsers.siteIds,
        deviceGroupIds: organizationUsers.deviceGroupIds
      })
      .from(organizationUsers)
      .innerJoin(users, eq(organizationUsers.userId, users.id))
      .innerJoin(roles, eq(organizationUsers.roleId, roles.id))
      .where(eq(organizationUsers.orgId, scopeContext.orgId));

    return c.json({ data });
  }
);

// --- Roles ---

userRoutes.get(
  '/roles',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);

    if (scopeContext.scope === 'partner') {
      const data = await db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          scope: roles.scope,
          isSystem: roles.isSystem
        })
        .from(roles)
        .where(
          and(
            eq(roles.scope, 'partner'),
            or(eq(roles.isSystem, true), eq(roles.partnerId, scopeContext.partnerId))
          )
        );

      return c.json({ data });
    }

    const data = await db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        scope: roles.scope,
        isSystem: roles.isSystem
      })
      .from(roles)
      .where(
        and(
          eq(roles.scope, 'organization'),
          or(eq(roles.isSystem, true), eq(roles.orgId, scopeContext.orgId))
        )
      );

    return c.json({ data });
  }
);

userRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id')!;

    const record = await getScopedUser(userId, scopeContext);

    if (!record) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json(record);
  }
);

userRoutes.post(
  '/invite',
  requirePermission(PERMISSIONS.USERS_INVITE.resource, PERMISSIONS.USERS_INVITE.action),
  requireMfa(),
  zValidator('json', inviteUserSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const data = c.req.valid('json');

    if (scopeContext.scope === 'partner') {
      const orgAccess = data.orgAccess ?? 'none';
      const orgIds = data.orgIds ?? [];

      if (orgAccess === 'selected' && orgIds.length === 0) {
        return c.json({ error: 'orgIds required when orgAccess is selected' }, 400);
      }

      if (orgAccess !== 'selected' && orgIds.length > 0) {
        return c.json({ error: 'orgIds can only be provided when orgAccess is selected' }, 400);
      }
    }

    if (scopeContext.scope === 'organization' && data.orgAccess) {
      return c.json({ error: 'orgAccess is only valid for partner scope' }, 400);
    }

    const role = await getScopedRole(data.roleId, scopeContext);
    if (!role) {
      return c.json({ error: 'Invalid role for this scope' }, 400);
    }
    const rolePermissionError = await validateAssignableRole(c, auth, role);
    if (rolePermissionError) {
      return c.json({ error: rolePermissionError }, 403);
    }

    const normalizedEmail = data.email.toLowerCase();

    const result = await db.transaction(async (tx) => {
      const [existingUser] = await tx
        .select()
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      let user = existingUser;

      // Resolve the invited user's primary tenancy from the caller's scope.
      // Partner admins inviting → partner-level staff (partner_id set, org_id
      // NULL). Org admins inviting → member of that org (partner_id inherited
      // from the org's owning partner, org_id set to the caller's org).
      const resolveInviteTenancy = async (): Promise<{ partnerId: string; orgId: string | null }> => {
        if (scopeContext.scope === 'partner') {
          return { partnerId: scopeContext.partnerId, orgId: null };
        }
        const [scopeOrg] = await tx
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, scopeContext.orgId))
          .limit(1);
        if (!scopeOrg) {
          throw new HTTPException(500, { message: 'Scope org not found' });
        }
        return { partnerId: scopeOrg.partnerId, orgId: scopeContext.orgId };
      };

      if (!user) {
        const tenancy = await resolveInviteTenancy();
        const [created] = await tx
          .insert(users)
          .values({
            partnerId: tenancy.partnerId,
            orgId: tenancy.orgId,
            email: normalizedEmail,
            name: data.name,
            status: 'invited'
          })
          .returning();

        user = created;
      } else if (user.status === 'disabled' && user.passwordHash === null) {
        // Resurrect a neutralized tombstone (#1367): a prior delete (or the
        // backfill migration) left this email as a disabled, password-less,
        // membership-less row. Reset it to a clean invited state so the new
        // invitee can set a password via the magic link (accept-invite requires
        // status='invited'), and re-home it under the inviting scope. We touch
        // ONLY tombstones (disabled + no password) — an active multi-membership
        // user being added to another scope keeps their credentials untouched.
        const tenancy = await resolveInviteTenancy();
        const [reset] = await tx
          .update(users)
          .set({
            name: data.name,
            status: 'invited',
            passwordHash: null,
            partnerId: tenancy.partnerId,
            orgId: tenancy.orgId,
            disabledReason: null,
            mfaEnabled: false,
            mfaSecret: null,
            mfaMethod: null,
            mfaRecoveryCodes: null,
            updatedAt: new Date()
          })
          .where(eq(users.id, user.id))
          .returning();

        user = reset;
      }

      if (!user) {
        throw new HTTPException(500, { message: 'Failed to create user' });
      }

      if (scopeContext.scope === 'partner') {
        const [existingLink] = await tx
          .select({ id: partnerUsers.id })
          .from(partnerUsers)
          .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), eq(partnerUsers.userId, user.id)))
          .limit(1);

        if (existingLink) {
          return { user, linkCreated: false };
        }

        const orgAccess = data.orgAccess ?? 'none';
        const orgIds = orgAccess === 'selected' ? data.orgIds ?? [] : null;

        const [link] = await tx
          .insert(partnerUsers)
          .values({
            partnerId: scopeContext.partnerId,
            userId: user.id,
            roleId: data.roleId,
            orgAccess,
            orgIds
          })
          .returning();

        return { user, linkCreated: true, link };
      }

      const [existingLink] = await tx
        .select({ id: organizationUsers.id })
        .from(organizationUsers)
        .where(and(eq(organizationUsers.orgId, scopeContext.orgId), eq(organizationUsers.userId, user.id)))
        .limit(1);

      if (existingLink) {
        return { user, linkCreated: false };
      }

      const [link] = await tx
        .insert(organizationUsers)
        .values({
          orgId: scopeContext.orgId,
          userId: user.id,
          roleId: data.roleId,
          siteIds: data.siteIds ?? null,
          deviceGroupIds: data.deviceGroupIds ?? null
        })
        .returning();

      return { user, linkCreated: true, link };
    });

    if (!result.linkCreated) {
      return c.json({ error: 'User already exists in this scope' }, 409);
    }
    await clearPermissionCache(result.user.id);

    const invite = await generateAndDeliverInvite(
      result.user.id,
      scopeContext,
      { email: result.user.email, name: result.user.name },
      auth.user
    );

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.invite',
      resourceId: result.user.id,
      resourceName: result.user.name,
      details: {
        invitedEmail: result.user.email,
        roleId: data.roleId,
        scope: scopeContext.scope,
        orgAccess: scopeContext.scope === 'partner' ? data.orgAccess ?? 'none' : undefined,
        orgIds: scopeContext.scope === 'partner' ? data.orgIds ?? [] : undefined,
        siteIds: scopeContext.scope === 'organization' ? data.siteIds ?? [] : undefined,
        deviceGroupIds: scopeContext.scope === 'organization' ? data.deviceGroupIds ?? [] : undefined,
        inviteEmailSent: invite.inviteEmailSent
      }
    });

    return c.json(
      {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        status: result.user.status,
        roleId: data.roleId,
        inviteEmailSent: invite.inviteEmailSent,
        inviteUrl: invite.inviteUrl,
        warning: invite.warning,
      },
      201
    );
  }
);

userRoutes.post(
  '/resend-invite',
  requirePermission(PERMISSIONS.USERS_INVITE.resource, PERMISSIONS.USERS_INVITE.action),
  requireMfa(),
  zValidator('json', resendInviteSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const { userId } = c.req.valid('json');

    const record = await getScopedUser(userId, scopeContext);

    if (!record) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (record.status !== 'invited') {
      return c.json({ error: 'User is not in invited status' }, 400);
    }

    const invite = await generateAndDeliverInvite(
      record.id,
      scopeContext,
      { email: record.email, name: record.name },
      auth.user
    );

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.invite.resend',
      resourceId: record.id,
      resourceName: record.name,
      details: {
        invitedEmail: record.email,
        scope: scopeContext.scope,
        inviteEmailSent: invite.inviteEmailSent
      }
    });

    return c.json({
      success: true,
      inviteEmailSent: invite.inviteEmailSent,
      inviteUrl: invite.inviteUrl,
      warning: invite.warning,
    });
  }
);

userRoutes.patch(
  '/:id',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  requireMfa(),
  zValidator('json', updateUserSchema),
  async (c) => {
    const auth = c.get('auth');
    const userId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (!data.name && !data.status) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    // Name and status live on the global identity row, which can be shared by
    // memberships in multiple partners. No partner-scoped authorization proof
    // can therefore establish authority over every tenant affected by this
    // mutation (including session revocation). Keep this operation platform
    // global and reject every tenant-scoped caller before any target lookup or
    // side effect. authMiddleware live-binds system scope to isPlatformAdmin.
    if (auth.scope !== 'system') {
      return c.json({ error: 'System access required to update global identity fields' }, 403);
    }

    const record = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [globalUser] = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            status: users.status,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        return globalUser ?? null;
      })
    );

    if (!record) {
      return c.json({ error: 'User not found' }, 404);
    }

    const updates: {
      name?: string;
      status?: 'active' | 'invited' | 'disabled';
      disabledReason?: string | null;
      updatedAt: Date;
    } = {
      updatedAt: new Date()
    };

    if (data.name) {
      updates.name = data.name;
    }

    if (data.status) {
      updates.status = data.status;
      // Any status change made here is a manual admin action, not a partner
      // suspension. Clear the suspension marker so a manual disable reads as
      // "disabled for another reason" (partner unsuspend must not re-enable it)
      // and so reactivation never leaves a stale marker behind. See #917 L-5.
      updates.disabledReason = null;
    }

    const [updated] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .update(users)
            .set(updates)
            .where(eq(users.id, userId))
            .returning({
              id: users.id,
              email: users.email,
              name: users.name,
              status: users.status
            });
          if (row && data.status !== undefined) {
            // An admin STATUS change invalidates prior sessions: advance
            // auth_epoch and durably revoke refresh families in the SAME
            // transaction so a rollback undoes both together. Scoped to
            // authentication-state changes only — a name-only edit must NOT
            // sign the user out everywhere.
            await advanceUserEpochs(tx, userId, { auth: true });
            await revokeAllRefreshFamilies(tx, userId, `status:${row.status ?? 'changed'}`);
          }
          return [row];
        })
      )
    );

    if (!updated) {
      return c.json({ error: 'Failed to update user' }, 500);
    }

    // Hot-path cleanup after the durable commit above: Redis token cutoff,
    // permission-cache clear, and OAuth-artifact revocation. Never throws —
    // see runPostCommitCleanup's doc comment for the partial-failure contract
    // this PATCH relies on below. Like the in-tx revocation, it only runs on
    // a status change — never on a name-only edit.
    const cleanup = data.status !== undefined ? await runPostCommitCleanup(updated.id) : undefined;

    // Suspension hook: when status transitions from active → disabled we must
    // revoke every outstanding OAuth artifact (refresh tokens, grant cache
    // markers, jti cache markers) so existing bearer tokens stop working
    // immediately. Reactivation (→ active) must NOT trigger this branch.
    // Any transition out of 'active' to a non-active value also qualifies.
    const becameInactive =
      data.status !== undefined &&
      data.status !== 'active' &&
      record.status === 'active' &&
      updated.status !== 'active';

    if (becameInactive) {
      // Kill any live remote-desktop sessions immediately so a suspended /
      // deactivated operator loses screen, input and clipboard control right
      // away — revoking JWT/OAuth alone does not touch viewer tokens or the
      // peer-to-peer WebRTC stream. Finding #3. The teardown is best-effort
      // per session, but a hard enumeration/disconnect failure returns the
      // TEARDOWN_FAILED sentinel (already reported to Sentry inside the
      // service). Surface it the same way as the partial-revocation path
      // below — the operator MUST know control may still be live.
      const teardownResult = await terminateUserRemoteSessions(updated.id);
      if (teardownResult === TEARDOWN_FAILED) {
        return c.json(
          { error: 'Failed to terminate active remote sessions; suspension is partial. Retry.' },
          503
        );
      }
      // becameInactive implies data.status !== undefined, so cleanup ran;
      // the optional chain only guards the type.
      if (!cleanup?.oauthOk) {
        // The DB rows are still marked revoked (committed above) but access
        // JWTs would survive until natural expiry. Treat this as a hard
        // failure so the operator knows suspension is partial.
        return c.json(
          { error: 'Failed to revoke active sessions; suspension is partial. Retry.' },
          503
        );
      }
    }

    writeUserAudit(c, auth, null, {
      action: becameInactive ? 'user.suspended' : 'user.update',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        changedFields: Object.keys(data),
        previousStatus: record.status,
        newStatus: updated.status,
        scope: auth.scope,
        ...(becameInactive && cleanup?.oauthResult
          ? {
              grantsRevoked: cleanup.oauthResult.grantsRevoked,
              refreshTokensRevoked: cleanup.oauthResult.refreshTokensRevoked,
              jtisRevoked: cleanup.oauthResult.jtisRevoked
            }
          : {})
      }
    });

    return c.json(updated);
  }
);

// A membership-only delete leaves the `users` row behind. If the user has no
// membership left in EITHER axis, that row is an orphan, and left active it is
// a problem two ways (#1367):
//   1. SECURITY: the "deleted" user can still authenticate. login.ts only
//      bounces on a null password_hash / non-active status, and
//      resolveCurrentUserTokenContext returns a null-context system-scope token
//      (instead of throwing) for a membership-less user — so a removed user who
//      still knows their password logs straight back in.
//   2. RESURRECTION: re-inviting the same email reuses the row with its stale
//      active status + password, blocking the new invitee's magic link.
// The row cannot be hard-deleted (dozens of created_by/approved_by FKs RESTRICT
// it), so we neutralize it: disable + strip password and MFA secrets. A later
// invite of this email resets it to a clean invited state (see /invite).
//
// MUST run under SYSTEM scope, not the caller's request scope: the orphan check
// has to see the user's memberships across EVERY tenant. An org admin's RLS
// view hides partner memberships and other orgs' rows, so a request-scoped
// check would falsely report a still-active multi-org user as orphaned and
// wrongly disable them. Takes the caller's `tx` (not the bare `db`) so the
// just-deleted membership — still uncommitted on this connection — is visible
// to the SELECTs below; a separate connection would not see it yet.
async function neutralizeUserIfOrphaned(tx: Tx, userId: string): Promise<void> {
  const [partnerLink] = await tx
    .select({ id: partnerUsers.id })
    .from(partnerUsers)
    .where(eq(partnerUsers.userId, userId))
    .limit(1);
  if (partnerLink) return;

  const [orgLink] = await tx
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(eq(organizationUsers.userId, userId))
    .limit(1);
  if (orgLink) return;

  await tx
    .update(users)
    .set({
      status: 'disabled',
      disabledReason: 'removed',
      passwordHash: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      mfaRecoveryCodes: null,
      updatedAt: new Date()
    })
    .where(eq(users.id, userId));
}

/**
 * Remove a user's membership in the caller's tenant and, if it was their last
 * membership anywhere, neutralize the orphaned `users` row — in one
 * SYSTEM-scoped transaction.
 *
 * System scope (not the request scope) is required for the orphan check to see
 * cross-tenant memberships, and so the neutralize UPDATE can target a `users`
 * row whose org_id lies outside the caller's scope without RLS silently
 * dropping it (the #1375 0-row trap). Tenant safety is preserved by the
 * explicit membership-delete WHERE clause, scoped to the caller's own
 * partner/org from their authenticated context — exactly as the request-scoped
 * delete was before. The membership delete, orphan neutralize, epoch advance
 * and refresh-family revoke all run in ONE `db.transaction` inside the system
 * context so a rollback undoes all of them together, and so the just-deleted
 * membership is visible to the orphan check.
 */
async function removeMembershipForScope(
  scopeContext: ScopeContext,
  userId: string
): Promise<{ deleted: boolean }> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const deleted =
          scopeContext.scope === 'partner'
            ? await tx
                .delete(partnerUsers)
                .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), eq(partnerUsers.userId, userId)))
                .returning({ id: partnerUsers.id })
            : await tx
                .delete(organizationUsers)
                .where(and(eq(organizationUsers.orgId, scopeContext.orgId), eq(organizationUsers.userId, userId)))
                .returning({ id: organizationUsers.id });

        if (deleted.length === 0) {
          return { deleted: false };
        }

        await neutralizeUserIfOrphaned(tx, userId);
        await advanceUserEpochs(tx, userId, { auth: true });
        await revokeAllRefreshFamilies(tx, userId, 'membership-removed');
        return { deleted: true };
      })
    )
  );
}

userRoutes.delete(
  '/:id',
  requirePermission(PERMISSIONS.USERS_DELETE.resource, PERMISSIONS.USERS_DELETE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id')!;

    if (scopeContext.scope === 'partner') {
      const { deleted } = await removeMembershipForScope(scopeContext, userId);

      if (!deleted) {
        return c.json({ error: 'User not found' }, 404);
      }

      writeUserAudit(c, auth, scopeContext, {
        action: 'user.remove',
        resourceId: userId,
        details: { scope: 'partner' }
      });
      // Task 9: the epoch bump + durable refresh-family revocation already
      // committed inside removeMembershipForScope's transaction. This runs
      // the hot-path cleanup (Redis token cutoff, permission-cache clear,
      // OAuth-artifact revocation) after that commit.
      await runPostCommitCleanup(userId);

      return c.json({ success: true });
    }

    const { deleted } = await removeMembershipForScope(scopeContext, userId);

    if (!deleted) {
      return c.json({ error: 'User not found' }, 404);
    }

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.remove',
      resourceId: userId,
      details: { scope: 'organization' }
    });
    // Task 9: see comment above — same rationale for org-scope users.
    await runPostCommitCleanup(userId);

    return c.json({ success: true });
  }
);

// Admin MFA reset — recovery path for a user who lost their authenticator and
// has no recovery codes (self-service POST /auth/mfa/disable is impossible for
// them: it demands a live code). An admin with USERS_WRITE over the target's
// tenant clears the factor and forces re-enrollment on next login.
//
// Deliberate design choices:
//  - NOT gated on the org/partner MFA-enforcement policy: enforcement blocks
//    self-disable, but this IS the recovery lever, and a still-enforced policy
//    simply forces the user to re-enroll at next login (which is the goal).
//  - NOT gated on ENABLE_2FA: if 2FA was turned off platform-wide, legacy
//    enabled rows can't be cleared via self-service (that path early-returns),
//    so admin reset is the ONLY recovery — it must keep working.
//  - Self is refused: an admin must not strip their OWN factor here (that would
//    bypass the code + password step-up the self-service flow requires).
//  - requireMfa() forces the acting admin's session to have satisfied MFA, so a
//    stolen access token alone cannot reset another user's second factor.
userRoutes.post(
  '/:id/mfa/reset',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id')!;

    if (userId === auth.user.id) {
      return c.json(
        { error: 'Use the self-service MFA disable flow to remove your own second factor' },
        400
      );
    }

    // Tenant boundary: getScopedUser only resolves a target that has a
    // membership in the caller's org/partner, so an admin cannot reset a user
    // outside their tenant (RLS on `users` is the second line of defense).
    const record = await getScopedUser(userId, scopeContext);
    if (!record) {
      return c.json({ error: 'User not found' }, 404);
    }

    const [mfaState] = await db
      .select({ mfaEnabled: users.mfaEnabled, mfaMethod: users.mfaMethod })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!mfaState?.mfaEnabled) {
      return c.json({ error: 'MFA is not enabled for this user' }, 400);
    }
    const previousMethod = mfaState.mfaMethod || 'totp';

    // Cross-user write: clear the factor + advance mfa_epoch (kills the target's
    // live access/refresh JWTs) + revoke refresh families + post-commit token/
    // OAuth cutoff + remote-session teardown, via the same primitive the
    // self-service disable uses. MUST run in system context — the target's
    // `refresh_token_families` rows are user-scoped RLS and the admin's ambient
    // context would revoke zero of them (see invalidateMfaAssuranceAfterFactorChange).
    const result = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        invalidateMfaAssuranceAfterFactorChange(userId, 'admin-mfa-reset', async (tx: Tx) => {
          await tx
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
            .where(eq(users.id, userId));
        })
      )
    );

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.mfa_reset',
      resourceId: userId,
      resourceName: record.email,
      details: {
        method: previousMethod,
        mfaEpoch: result.mfaEpoch,
        teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED
      }
    });

    return c.json({ success: true, message: 'MFA reset for user' });
  }
);

userRoutes.post(
  '/:id/role',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  requireMfa(),
  zValidator('json', assignRoleSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id')!;
    const { roleId } = c.req.valid('json');

    if (userId === auth.user.id) {
      return c.json({ error: 'Self role assignment is not allowed' }, 403);
    }

    const role = await getScopedRole(roleId, scopeContext);
    if (!role) {
      return c.json({ error: 'Invalid role for this scope' }, 400);
    }
    const rolePermissionError = await validateAssignableRole(c, auth, role);
    if (rolePermissionError) {
      return c.json({ error: rolePermissionError }, 403);
    }

    if (scopeContext.scope === 'partner') {
      const updated = await db
        .update(partnerUsers)
        .set({ roleId })
        .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), eq(partnerUsers.userId, userId)))
        .returning({ id: partnerUsers.id });

      if (updated.length === 0) {
        return c.json({ error: 'User not found' }, 404);
      }

      writeUserAudit(c, auth, scopeContext, {
        action: 'user.role.assign',
        resourceId: userId,
        details: {
          roleId,
          roleName: role.name,
          scope: 'partner'
        }
      });
      await clearPermissionCache(userId);

      return c.json({ success: true });
    }

    const updated = await db
      .update(organizationUsers)
      .set({ roleId })
      .where(and(eq(organizationUsers.orgId, scopeContext.orgId), eq(organizationUsers.userId, userId)))
      .returning({ id: organizationUsers.id });

    if (updated.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.role.assign',
      resourceId: userId,
      details: {
        roleId,
        roleName: role.name,
        scope: 'organization'
      }
    });
    await clearPermissionCache(userId);

    return c.json({ success: true });
  }
);
