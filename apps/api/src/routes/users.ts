import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { and, eq, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { nanoid } from 'nanoid';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users, partnerUsers, organizationUsers, roles, organizations, permissions, rolePermissions } from '../db/schema';
import { authMiddleware, hasSatisfiedMfa, requireMfa, requirePermission } from '../middleware/auth';
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
  hasPermission,
  isAssignablePermission,
  PERMISSIONS,
  type UserPermissions
} from '../services/permissions';
import { createAuditLogAsync } from '../services/auditService';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { getEmailService } from '../services/email';
import { captureException } from '../services/sentry';
import { getRedis } from '../services';
import { INVITE_TOKEN_TTL_SECONDS } from './auth/schemas';
import { hashInviteToken, inviteRedisKey, inviteUserRedisKey, requireCurrentPasswordStepUp, resolveUserAuditOrgId, userRequiresSetup } from './auth/helpers';
import { isPasswordAuthDisabledBySso } from './auth/ssoPolicy';
import { revokeUserAccess } from '../services/userSuspension';
import { terminateUserRemoteSessions, TEARDOWN_FAILED } from '../services/remoteSessionTeardown';
import { revokeAllUserTokens } from '../services/tokenRevocation';

export const userRoutes = new Hono();

userRoutes.use('*', authMiddleware);
userRoutes.use('*', async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.scope !== 'partner') {
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
  const accessibleOrgIds = auth.accessibleOrgIds;

  const partnerOrgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, auth.partnerId));
  const hasFullPartnerAccess = partnerOrgRows.every((org) => accessibleOrgIds.includes(org.id));

  if (!hasFullPartnerAccess) {
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

type ScopeContext =
  | { scope: 'partner'; partnerId: string }
  | { scope: 'organization'; orgId: string };

function getScopeContext(auth: { scope: string; partnerId: string | null; orgId: string | null }): ScopeContext {
  if (auth.scope === 'partner' && auth.partnerId) {
    return { scope: 'partner', partnerId: auth.partnerId };
  }

  if (auth.scope === 'organization' && auth.orgId) {
    return { scope: 'organization', orgId: auth.orgId };
  }

  throw new HTTPException(403, { message: 'Partner or organization context required' });
}

async function getScopedRole(roleId: string, scopeContext: ScopeContext) {
  const [role] = await db
    .select({
      id: roles.id,
      scope: roles.scope,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      parentRoleId: roles.parentRoleId,
      partnerId: roles.partnerId,
      orgId: roles.orgId
    })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);

  if (!role || role.scope !== scopeContext.scope) {
    return null;
  }

  if (role.isSystem) {
    return role;
  }

  if (scopeContext.scope === 'partner' && role.partnerId === scopeContext.partnerId) {
    return role;
  }

  if (scopeContext.scope === 'organization' && role.orgId === scopeContext.orgId) {
    return role;
  }

  return null;
}

async function getEffectiveRolePermissions(
  roleId: string,
  visited: Set<string> = new Set()
): Promise<Array<{ resource: string; action: string }>> {
  if (visited.has(roleId)) return [];
  visited.add(roleId);

  const [role] = await db
    .select({ parentRoleId: roles.parentRoleId })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);

  const directPermissions = await db
    .select({
      resource: permissions.resource,
      action: permissions.action
    })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  if (!role?.parentRoleId) {
    return directPermissions;
  }

  const inheritedPermissions = await getEffectiveRolePermissions(role.parentRoleId, visited);
  const result = new Map<string, { resource: string; action: string }>();
  for (const permission of [...directPermissions, ...inheritedPermissions]) {
    result.set(`${permission.resource}:${permission.action}`, permission);
  }
  return [...result.values()];
}

async function getCallerPermissions(
  c: any,
  auth: { user: { id: string }; partnerId: string | null; orgId: string | null }
): Promise<UserPermissions | null> {
  const existing = c.get('permissions') as UserPermissions | undefined;
  if (existing) return existing;

  return getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined
  });
}

async function validateAssignableRole(
  c: any,
  auth: { user: { id: string }; partnerId: string | null; orgId: string | null },
  role: { id: string; isSystem: boolean }
): Promise<string | null> {
  const rolePermissionsForAssignment = await getEffectiveRolePermissions(role.id);
  if (rolePermissionsForAssignment.length === 0) {
    return null;
  }

  const callerPermissions = await getCallerPermissions(c, auth);
  if (!callerPermissions) {
    return 'No permissions found';
  }

  for (const permission of rolePermissionsForAssignment) {
    if (permission.resource === '*' || permission.action === '*') {
      if (!role.isSystem) {
        return 'Custom roles with wildcard permissions cannot be assigned';
      }
      if (!hasPermission(callerPermissions, permission.resource, permission.action)) {
        return 'Cannot assign a role broader than caller permissions';
      }
      continue;
    }

    if (!isAssignablePermission(permission)) {
      return `Role contains unknown permission: ${permission.resource}:${permission.action}`;
    }

    if (!hasPermission(callerPermissions, permission.resource, permission.action)) {
      return `Cannot assign a role with permission not held by caller: ${permission.resource}:${permission.action}`;
    }
  }

  return null;
}

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
  scopeContext: ScopeContext,
  event: {
    action: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
  }
): void {
  const orgId = resolveAuditOrgId(auth, scopeContext);

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
      preferences: users.preferences
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
  // The address that owned the account before the change — used for the audit
  // detail and the security notification to the OLD address.
  let previousEmail: string | undefined;

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
        ?? validatePreferenceEnum(prefs, 'font', ['breeze', 'system'], 'breeze or system');
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
    // self.email is already normalized in the DB; only step-up + notify when the
    // email is genuinely changing. A same-email "change" is a no-op here.
    const emailChanging = normalizedEmail !== self.email;

    if (emailChanging) {
      // Account-takeover step-up — mirror change-password's SSO→password
      // ordering; additionally allow MFA step-up for passwordless users
      // (change-password rejects them with 400), BEFORE any write.
      // (a) SSO-enforced org: email is managed at the IdP.
      if (await isPasswordAuthDisabledBySso({ scope: auth.scope, orgId: auth.orgId })) {
        return c.json({ error: 'Email changes for this organization are managed through your SSO provider.' }, 403);
      }

      if (self.passwordHash) {
        // (b) Local-password user: require + verify the current password.
        if (!body.currentPassword) {
          return c.json({ error: 'Current password is required to change your email address.' }, 400);
        }
        const stepUp = await requireCurrentPasswordStepUp(c, auth.user.id, body.currentPassword, 'email-change:pwd');
        if (stepUp) return stepUp; // 401 / 429 / 503 Response, or null on success
        stepUpMethod = 'password';
      } else {
        // (c) Passwordless, non-SSO-enforced user: require satisfied MFA.
        if (!hasSatisfiedMfa(auth)) {
          return c.json({ error: 'MFA verification is required to change your email address.' }, 403);
        }
        stepUpMethod = 'mfa';
      }

      previousEmail = self.email;

      // Uniqueness check (only matters when the email is actually changing).
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);
      if (existing && existing.id !== auth.user.id) {
        return c.json({ error: 'Email already in use' }, 409);
      }
    }

    // Always include the (normalized) email in the write. When it's unchanged
    // this is a harmless no-op that keeps a same-email PATCH a valid 200 rather
    // than a "No valid updates provided" 400, and it requires no step-up.
    updates.email = normalizedEmail;
  }

  if (Object.keys(updates).length === 1) {
    return c.json({ error: 'No valid updates provided' }, 400);
  }

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, auth.user.id))
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      status: users.status,
      mfaEnabled: users.mfaEnabled,
      preferences: users.preferences
    });

  if (!updated) {
    return c.json({ error: 'Failed to update profile' }, 500);
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
      changedFields: Object.keys(updates).filter((key) => key !== 'updatedAt')
    },
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });

  // Dedicated email-change audit + security notification to the OLD address.
  // Only fires on a genuine, step-up-cleared email change (previousEmail set).
  if (previousEmail !== undefined) {
    createAuditLogAsync({
      orgId: auditOrgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'user.email.change',
      resourceType: 'user',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        previousEmail,
        newEmail: updated.email,
        stepUp: stepUpMethod
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success'
    });

    // Notify the OLD address (best-effort: never FAILs the request (errors are
    // swallowed). It is awaited, so it adds the send latency to this (rare)
    // email-change response).
    const emailService = getEmailService();
    if (emailService) {
      try {
        await emailService.sendEmailChanged({ to: previousEmail, name: updated.name, newEmail: updated.email });
      } catch (err) {
        console.error('[users] Failed to send email-change security notice', err);
        captureException(err);
      }
    } else {
      console.warn('[users] Email service not configured; email-change security notice was not sent');
    }
  }

  return c.json(updated);
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
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (!data.name && !data.status) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const record = await getScopedUser(userId, scopeContext);

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

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status
      });

    if (!updated) {
      return c.json({ error: 'Failed to update user' }, 500);
    }

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

    let oauthRevocation: Awaited<ReturnType<typeof revokeUserAccess>> | undefined;
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
      try {
        oauthRevocation = await revokeUserAccess(updated.id);
      } catch (err) {
        // Revocation cache failure → the DB rows are still marked revoked
        // but access JWTs would survive until natural expiry. Treat this as
        // a hard failure so the operator knows suspension is partial.
        return c.json(
          { error: 'Failed to revoke active sessions; suspension is partial. Retry.' },
          503
        );
      }
    }
    await clearPermissionCache(updated.id);

    writeUserAudit(c, auth, scopeContext, {
      action: becameInactive ? 'user.suspended' : 'user.update',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        changedFields: Object.keys(data),
        previousStatus: record.status,
        newStatus: updated.status,
        scope: scopeContext.scope,
        ...(oauthRevocation
          ? {
              grantsRevoked: oauthRevocation.grantsRevoked,
              refreshTokensRevoked: oauthRevocation.refreshTokensRevoked,
              jtisRevoked: oauthRevocation.jtisRevoked
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
// wrongly disable them. The caller is assumed to already be inside this file's
// system-scoped removal transaction so the just-deleted membership is visible.
async function neutralizeUserIfOrphaned(userId: string): Promise<void> {
  const [partnerLink] = await db
    .select({ id: partnerUsers.id })
    .from(partnerUsers)
    .where(eq(partnerUsers.userId, userId))
    .limit(1);
  if (partnerLink) return;

  const [orgLink] = await db
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(eq(organizationUsers.userId, userId))
    .limit(1);
  if (orgLink) return;

  await db
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
 * delete was before. Running delete + check + neutralize in one transaction is
 * what makes the just-deleted membership visible to the orphan check.
 */
async function removeMembershipForScope(
  scopeContext: ScopeContext,
  userId: string
): Promise<{ deleted: boolean }> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const deleted =
        scopeContext.scope === 'partner'
          ? await db
              .delete(partnerUsers)
              .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), eq(partnerUsers.userId, userId)))
              .returning({ id: partnerUsers.id })
          : await db
              .delete(organizationUsers)
              .where(and(eq(organizationUsers.orgId, scopeContext.orgId), eq(organizationUsers.userId, userId)))
              .returning({ id: organizationUsers.id });

      if (deleted.length === 0) {
        return { deleted: false };
      }

      await neutralizeUserIfOrphaned(userId);
      return { deleted: true };
    })
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
      await clearPermissionCache(userId);
      // Task 14: revoke the removed user's JWTs so the existing access
      // token can't keep granting partner-scoped reads/writes for up to 15
      // minutes (access-TTL). Best-effort: a Redis failure here leaves the
      // DB row deleted and the JWT will expire on its own — we log and
      // continue so the remove still succeeds.
      await revokeAllUserTokens(userId).catch((err) => {
        console.error('[users] token revoke failed after partner-user removal:', err);
      });
      // Also revoke OAuth grants/refresh tokens (e.g. MCP) so a removed user's
      // refresh token can't keep minting access tokens after they lose access.
      await revokeUserAccess(userId).catch((err) => {
        console.error('[users] oauth revoke failed after partner-user removal:', err);
      });

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
    await clearPermissionCache(userId);
    // Task 14: see comment above — same rationale for org-scope users.
    await revokeAllUserTokens(userId).catch((err) => {
      console.error('[users] token revoke failed after org-user removal:', err);
    });
    // Also revoke OAuth grants/refresh tokens (e.g. MCP) — see partner branch.
    await revokeUserAccess(userId).catch((err) => {
      console.error('[users] oauth revoke failed after org-user removal:', err);
    });

    return c.json({ success: true });
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
