import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { users, partnerUsers, organizationUsers, roles, organizations } from '../db/schema';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { createAuditLogAsync } from '../services/auditService';

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

  const partnerOrgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, auth.partnerId));
  const hasFullPartnerAccess = partnerOrgRows.every((org) => auth.accessibleOrgIds.includes(org.id));

  if (!hasFullPartnerAccess) {
    throw new HTTPException(403, { message: 'Full partner organization access required' });
  }

  await next();
});

const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  roleId: z.string().uuid(),
  orgAccess: z.enum(['all', 'selected', 'none']).optional(),
  orgIds: z.array(z.string().uuid()).optional(),
  siteIds: z.array(z.string().uuid()).optional(),
  deviceGroupIds: z.array(z.string().uuid()).optional()
});

const resendInviteSchema = z.object({
  userId: z.string().uuid()
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional()
});

const assignRoleSchema = z.object({
  roleId: z.string().uuid()
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
  if (!orgId) {
    return;
  }

  createAuditLogAsync({
    orgId,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: event.action,
    resourceType: 'user',
    resourceId: event.resourceId,
    resourceName: event.resourceName,
    details: event.details,
    ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
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
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt
    })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({
    ...user,
    partnerId: auth.partnerId,
    orgId: auth.orgId,
    scope: auth.scope
  });
});

// Update current user's profile
userRoutes.patch('/me', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();

  const updates: { name?: string; avatarUrl?: string; updatedAt: Date } = {
    updatedAt: new Date()
  };

  if (body.name && typeof body.name === 'string') {
    updates.name = body.name.slice(0, 255);
  }

  if (body.avatarUrl !== undefined) {
    updates.avatarUrl = body.avatarUrl;
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
      mfaEnabled: users.mfaEnabled
    });

  if (!updated) {
    return c.json({ error: 'Failed to update profile' }, 500);
  }

  if (auth.orgId) {
    createAuditLogAsync({
      orgId: auth.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'user.profile.update',
      resourceType: 'user',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        changedFields: Object.keys(updates).filter((key) => key !== 'updatedAt')
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      userAgent: c.req.header('user-agent'),
      result: 'success'
    });
  }

  return c.json(updated);
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
    const userId = c.req.param('id');

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

    const normalizedEmail = data.email.toLowerCase();

    const result = await db.transaction(async (tx) => {
      const [existingUser] = await tx
        .select()
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      let user = existingUser;

      if (!user) {
        const [created] = await tx
          .insert(users)
          .values({
            email: normalizedEmail,
            name: data.name,
            status: 'invited'
          })
          .returning();

        user = created;
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
        deviceGroupIds: scopeContext.scope === 'organization' ? data.deviceGroupIds ?? [] : undefined
      }
    });

    return c.json(
      {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        status: result.user.status,
        roleId: data.roleId
      },
      201
    );
  }
);

userRoutes.post(
  '/resend-invite',
  requirePermission(PERMISSIONS.USERS_INVITE.resource, PERMISSIONS.USERS_INVITE.action),
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

    // TODO: Send invitation email

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.invite.resend',
      resourceId: record.id,
      resourceName: record.name,
      details: {
        invitedEmail: record.email,
        scope: scopeContext.scope
      }
    });

    return c.json({ success: true });
  }
);

userRoutes.patch(
  '/:id',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', updateUserSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id');
    const data = c.req.valid('json');

    if (!data.name && !data.status) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const record = await getScopedUser(userId, scopeContext);

    if (!record) {
      return c.json({ error: 'User not found' }, 404);
    }

    const updates: { name?: string; status?: 'active' | 'invited' | 'disabled'; updatedAt: Date } = {
      updatedAt: new Date()
    };

    if (data.name) {
      updates.name = data.name;
    }

    if (data.status) {
      updates.status = data.status;
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

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.update',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        changedFields: Object.keys(data),
        previousStatus: record.status,
        newStatus: updated.status,
        scope: scopeContext.scope
      }
    });

    return c.json(updated);
  }
);

userRoutes.delete(
  '/:id',
  requirePermission(PERMISSIONS.USERS_DELETE.resource, PERMISSIONS.USERS_DELETE.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id');

    if (scopeContext.scope === 'partner') {
      const deleted = await db
        .delete(partnerUsers)
        .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), eq(partnerUsers.userId, userId)))
        .returning({ id: partnerUsers.id });

      if (deleted.length === 0) {
        return c.json({ error: 'User not found' }, 404);
      }

      writeUserAudit(c, auth, scopeContext, {
        action: 'user.remove',
        resourceId: userId,
        details: { scope: 'partner' }
      });

      return c.json({ success: true });
    }

    const deleted = await db
      .delete(organizationUsers)
      .where(and(eq(organizationUsers.orgId, scopeContext.orgId), eq(organizationUsers.userId, userId)))
      .returning({ id: organizationUsers.id });

    if (deleted.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.remove',
      resourceId: userId,
      details: { scope: 'organization' }
    });

    return c.json({ success: true });
  }
);

userRoutes.post(
  '/:id/role',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', assignRoleSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const userId = c.req.param('id');
    const { roleId } = c.req.valid('json');

    const role = await getScopedRole(roleId, scopeContext);
    if (!role) {
      return c.json({ error: 'Invalid role for this scope' }, 400);
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

    return c.json({ success: true });
  }
);
