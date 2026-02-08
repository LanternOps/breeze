import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, or, count, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { roles, permissions, rolePermissions, partnerUsers, organizationUsers, users, organizations } from '../db/schema';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { createAuditLogAsync } from '../services/auditService';

export const roleRoutes = new Hono();

roleRoutes.use('*', authMiddleware);
roleRoutes.use('*', async (c, next) => {
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

// Define available resources and actions for the permission matrix
export const AVAILABLE_RESOURCES = [
  'devices',
  'scripts',
  'alerts',
  'automations',
  'reports',
  'users',
  'settings',
  'organizations',
  'sites',
  'remote'
] as const;

export const AVAILABLE_ACTIONS = ['view', 'create', 'update', 'delete', 'execute'] as const;

const permissionSchema = z.object({
  resource: z.string().min(1),
  action: z.string().min(1)
});

const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  permissions: z.array(permissionSchema).default([]),
  parentRoleId: z.string().uuid().nullable().optional()
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  permissions: z.array(permissionSchema).optional(),
  parentRoleId: z.string().uuid().nullable().optional()
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

function resolveAuditOrgId(auth: { orgId: string | null }, scopeContext: ScopeContext): string | null {
  if (scopeContext.scope === 'organization') {
    return scopeContext.orgId;
  }
  return auth.orgId ?? null;
}

function writeRoleAudit(
  c: any,
  auth: { orgId: string | null; user: { id: string; email?: string } },
  scopeContext: ScopeContext,
  event: {
    action: string;
    roleId?: string;
    roleName?: string;
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
    resourceType: 'role',
    resourceId: event.roleId,
    resourceName: event.roleName,
    details: event.details,
    ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });
}

// Helper to get or create permission by resource/action
async function getOrCreatePermission(resource: string, action: string): Promise<string> {
  const [existing] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(and(eq(permissions.resource, resource), eq(permissions.action, action)))
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const [created] = await db
    .insert(permissions)
    .values({
      resource,
      action,
      description: `${action} access for ${resource}`
    })
    .returning({ id: permissions.id });

  if (!created) {
    throw new HTTPException(500, { message: 'Failed to create permission' });
  }

  return created.id;
}

// Helper to get all ancestor role IDs (for circular inheritance check)
async function getAncestorRoleIds(roleId: string, visited: Set<string> = new Set()): Promise<Set<string>> {
  if (visited.has(roleId)) {
    return visited;
  }
  visited.add(roleId);

  const [role] = await db
    .select({ parentRoleId: roles.parentRoleId })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);

  if (role?.parentRoleId) {
    await getAncestorRoleIds(role.parentRoleId, visited);
  }

  return visited;
}

// Helper to get all descendant role IDs (for circular inheritance check)
async function getDescendantRoleIds(roleId: string, visited: Set<string> = new Set()): Promise<Set<string>> {
  if (visited.has(roleId)) {
    return visited;
  }
  visited.add(roleId);

  const children = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.parentRoleId, roleId));

  for (const child of children) {
    await getDescendantRoleIds(child.id, visited);
  }

  return visited;
}

// Helper to check if setting a parent would create circular inheritance
async function wouldCreateCircularInheritance(roleId: string, newParentId: string): Promise<boolean> {
  // A role cannot be its own parent
  if (roleId === newParentId) {
    return true;
  }

  // Check if the new parent is a descendant of the role
  const descendants = await getDescendantRoleIds(roleId);
  return descendants.has(newParentId);
}

// Helper to validate parent role is accessible in the same scope
async function validateParentRole(
  parentRoleId: string,
  scopeContext: ScopeContext
): Promise<{ valid: boolean; error?: string }> {
  const [parentRole] = await db
    .select({
      id: roles.id,
      scope: roles.scope,
      isSystem: roles.isSystem,
      partnerId: roles.partnerId,
      orgId: roles.orgId
    })
    .from(roles)
    .where(eq(roles.id, parentRoleId))
    .limit(1);

  if (!parentRole) {
    return { valid: false, error: 'Parent role not found' };
  }

  // Parent role must be in the same scope
  if (parentRole.scope !== scopeContext.scope) {
    return { valid: false, error: 'Parent role must be in the same scope' };
  }

  // If parent is not a system role, it must belong to the same partner/org
  if (!parentRole.isSystem) {
    if (scopeContext.scope === 'partner' && parentRole.partnerId !== scopeContext.partnerId) {
      return { valid: false, error: 'Parent role not accessible' };
    }
    if (scopeContext.scope === 'organization' && parentRole.orgId !== scopeContext.orgId) {
      return { valid: false, error: 'Parent role not accessible' };
    }
  }

  return { valid: true };
}

// Helper to get effective permissions (own + inherited from parent chain)
async function getEffectivePermissions(
  roleId: string,
  visited: Set<string> = new Set()
): Promise<{ resource: string; action: string; inherited: boolean; sourceRoleId: string; sourceRoleName: string }[]> {
  if (visited.has(roleId)) {
    return [];
  }
  visited.add(roleId);

  // Get the role info
  const [role] = await db
    .select({
      id: roles.id,
      name: roles.name,
      parentRoleId: roles.parentRoleId
    })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);

  if (!role) {
    return [];
  }

  // Get direct permissions for this role
  const directPerms = await db
    .select({
      resource: permissions.resource,
      action: permissions.action
    })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  const result: { resource: string; action: string; inherited: boolean; sourceRoleId: string; sourceRoleName: string }[] = directPerms.map((p) => ({
    resource: p.resource,
    action: p.action,
    inherited: false,
    sourceRoleId: role.id,
    sourceRoleName: role.name
  }));

  // Get inherited permissions from parent
  if (role.parentRoleId) {
    const inheritedPerms = await getEffectivePermissions(role.parentRoleId, visited);

    // Add inherited permissions that aren't already directly assigned
    const directPermSet = new Set(directPerms.map((p) => `${p.resource}:${p.action}`));

    for (const inherited of inheritedPerms) {
      const key = `${inherited.resource}:${inherited.action}`;
      if (!directPermSet.has(key)) {
        result.push({
          ...inherited,
          inherited: true
        });
      }
    }
  }

  return result;
}

// GET /roles - List all roles (system + custom for scope)
roleRoutes.get(
  '/',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);

    let rolesData;

    if (scopeContext.scope === 'partner') {
      rolesData = await db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          scope: roles.scope,
          isSystem: roles.isSystem,
          parentRoleId: roles.parentRoleId,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt
        })
        .from(roles)
        .where(
          and(
            eq(roles.scope, 'partner'),
            or(eq(roles.isSystem, true), eq(roles.partnerId, scopeContext.partnerId))
          )
        );
    } else {
      rolesData = await db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          scope: roles.scope,
          isSystem: roles.isSystem,
          parentRoleId: roles.parentRoleId,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt
        })
        .from(roles)
        .where(
          and(
            eq(roles.scope, 'organization'),
            or(eq(roles.isSystem, true), eq(roles.orgId, scopeContext.orgId))
          )
        );
    }

    // Get user counts for each role
    const roleIds = rolesData.map((r) => r.id);

    let userCounts: { roleId: string; count: number }[] = [];

    if (roleIds.length > 0) {
      if (scopeContext.scope === 'partner') {
        const counts = await db
          .select({
            roleId: partnerUsers.roleId,
            count: count()
          })
          .from(partnerUsers)
          .where(
            and(
              eq(partnerUsers.partnerId, scopeContext.partnerId),
              inArray(partnerUsers.roleId, roleIds)
            )
          )
          .groupBy(partnerUsers.roleId);

        userCounts = counts.map((c) => ({ roleId: c.roleId, count: Number(c.count) }));
      } else {
        const counts = await db
          .select({
            roleId: organizationUsers.roleId,
            count: count()
          })
          .from(organizationUsers)
          .where(
            and(
              eq(organizationUsers.orgId, scopeContext.orgId),
              inArray(organizationUsers.roleId, roleIds)
            )
          )
          .groupBy(organizationUsers.roleId);

        userCounts = counts.map((c) => ({ roleId: c.roleId, count: Number(c.count) }));
      }
    }

    const userCountMap = new Map(userCounts.map((uc) => [uc.roleId, uc.count]));

    // Build a map of role IDs to names for parent role lookup
    const roleNameMap = new Map(rolesData.map((r) => [r.id, r.name]));

    const data = rolesData.map((role) => ({
      ...role,
      parentRoleName: role.parentRoleId ? roleNameMap.get(role.parentRoleId) || null : null,
      userCount: userCountMap.get(role.id) || 0
    }));

    return c.json({ data });
  }
);

// POST /roles - Create custom role for organization
roleRoutes.post(
  '/',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', createRoleSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const body = c.req.valid('json');

    // Validate parent role if provided
    if (body.parentRoleId) {
      const validation = await validateParentRole(body.parentRoleId, scopeContext);
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }
    }

    // Create role
    const roleData: {
      name: string;
      description: string | null;
      scope: 'partner' | 'organization';
      isSystem: boolean;
      parentRoleId?: string | null;
      partnerId?: string;
      orgId?: string;
    } = {
      name: body.name,
      description: body.description || null,
      scope: scopeContext.scope,
      isSystem: false,
      parentRoleId: body.parentRoleId || null
    };

    if (scopeContext.scope === 'partner') {
      roleData.partnerId = scopeContext.partnerId;
    } else {
      roleData.orgId = scopeContext.orgId;
    }

    const result = await db.transaction(async (tx) => {
      const [newRole] = await tx
        .insert(roles)
        .values(roleData)
        .returning();

      if (!newRole) {
        throw new HTTPException(500, { message: 'Failed to create role' });
      }

      // Add permissions to role
      if (body.permissions.length > 0) {
        const permissionIds: string[] = [];

        for (const perm of body.permissions) {
          const permId = await getOrCreatePermission(perm.resource, perm.action);
          permissionIds.push(permId);
        }

        await tx.insert(rolePermissions).values(
          permissionIds.map((permId) => ({
            roleId: newRole.id,
            permissionId: permId
          }))
        );
      }

      return newRole;
    });

    // Get parent role name if exists
    let parentRoleName: string | null = null;
    if (result.parentRoleId) {
      const [parent] = await db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, result.parentRoleId))
        .limit(1);
      parentRoleName = parent?.name || null;
    }

    writeRoleAudit(c, auth, scopeContext, {
      action: 'role.create',
      roleId: result.id,
      roleName: result.name,
      details: {
        scope: scopeContext.scope,
        permissionCount: body.permissions.length,
        parentRoleId: result.parentRoleId ?? null
      }
    });

    return c.json(
      {
        id: result.id,
        name: result.name,
        description: result.description,
        scope: result.scope,
        isSystem: result.isSystem,
        parentRoleId: result.parentRoleId,
        parentRoleName,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      },
      201
    );
  }
);

// GET /roles/:id - Get role with permissions
roleRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const roleId = c.req.param('id');

    // Get role
    const [role] = await db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        scope: roles.scope,
        isSystem: roles.isSystem,
        parentRoleId: roles.parentRoleId,
        partnerId: roles.partnerId,
        orgId: roles.orgId,
        createdAt: roles.createdAt,
        updatedAt: roles.updatedAt
      })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);

    if (!role) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Verify access to this role
    if (!role.isSystem) {
      if (scopeContext.scope === 'partner' && role.partnerId !== scopeContext.partnerId) {
        return c.json({ error: 'Role not found' }, 404);
      }
      if (scopeContext.scope === 'organization' && role.orgId !== scopeContext.orgId) {
        return c.json({ error: 'Role not found' }, 404);
      }
    }

    if (role.scope !== scopeContext.scope) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Get permissions for the role
    const rolePerms = await db
      .select({
        resource: permissions.resource,
        action: permissions.action
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, roleId));

    // Get user count
    let userCount = 0;
    if (scopeContext.scope === 'partner') {
      const [result] = await db
        .select({ count: count() })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.partnerId, scopeContext.partnerId),
            eq(partnerUsers.roleId, roleId)
          )
        );
      userCount = Number(result?.count || 0);
    } else {
      const [result] = await db
        .select({ count: count() })
        .from(organizationUsers)
        .where(
          and(
            eq(organizationUsers.orgId, scopeContext.orgId),
            eq(organizationUsers.roleId, roleId)
          )
        );
      userCount = Number(result?.count || 0);
    }

    // Get parent role name if exists
    let parentRoleName: string | null = null;
    if (role.parentRoleId) {
      const [parent] = await db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, role.parentRoleId))
        .limit(1);
      parentRoleName = parent?.name || null;
    }

    return c.json({
      id: role.id,
      name: role.name,
      description: role.description,
      scope: role.scope,
      isSystem: role.isSystem,
      parentRoleId: role.parentRoleId,
      parentRoleName,
      permissions: rolePerms,
      userCount,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt
    });
  }
);

// PATCH /roles/:id - Update custom role
roleRoutes.patch(
  '/:id',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', updateRoleSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const roleId = c.req.param('id');
    const body = c.req.valid('json');

    // Get role
    const [role] = await db
      .select({
        id: roles.id,
        isSystem: roles.isSystem,
        scope: roles.scope,
        partnerId: roles.partnerId,
        orgId: roles.orgId
      })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);

    if (!role) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Cannot modify system roles
    if (role.isSystem) {
      return c.json({ error: 'Cannot modify system roles' }, 403);
    }

    // Verify ownership
    if (scopeContext.scope === 'partner' && role.partnerId !== scopeContext.partnerId) {
      return c.json({ error: 'Role not found' }, 404);
    }
    if (scopeContext.scope === 'organization' && role.orgId !== scopeContext.orgId) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Validate parent role if being updated
    if (body.parentRoleId !== undefined && body.parentRoleId !== null) {
      const validation = await validateParentRole(body.parentRoleId, scopeContext);
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }

      // Check for circular inheritance
      const wouldBeCircular = await wouldCreateCircularInheritance(roleId, body.parentRoleId);
      if (wouldBeCircular) {
        return c.json({ error: 'Cannot set parent role: would create circular inheritance' }, 400);
      }
    }

    const result = await db.transaction(async (tx) => {
      // Update role fields
      const updates: { name?: string; description?: string | null; parentRoleId?: string | null; updatedAt: Date } = {
        updatedAt: new Date()
      };

      if (body.name !== undefined) {
        updates.name = body.name;
      }

      if (body.description !== undefined) {
        updates.description = body.description;
      }

      if (body.parentRoleId !== undefined) {
        updates.parentRoleId = body.parentRoleId;
      }

      const [updatedRole] = await tx
        .update(roles)
        .set(updates)
        .where(eq(roles.id, roleId))
        .returning();

      if (!updatedRole) {
        throw new HTTPException(500, { message: 'Failed to update role' });
      }

      // Update permissions if provided
      if (body.permissions !== undefined) {
        // Remove existing permissions
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

        // Add new permissions
        if (body.permissions.length > 0) {
          const permissionIds: string[] = [];

          for (const perm of body.permissions) {
            const permId = await getOrCreatePermission(perm.resource, perm.action);
            permissionIds.push(permId);
          }

          await tx.insert(rolePermissions).values(
            permissionIds.map((permId) => ({
              roleId: roleId,
              permissionId: permId
            }))
          );
        }
      }

      return updatedRole;
    });

    // Get updated permissions
    const rolePerms = await db
      .select({
        resource: permissions.resource,
        action: permissions.action
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, roleId));

    // Get parent role name if exists
    let parentRoleName: string | null = null;
    if (result.parentRoleId) {
      const [parent] = await db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, result.parentRoleId))
        .limit(1);
      parentRoleName = parent?.name || null;
    }

    writeRoleAudit(c, auth, scopeContext, {
      action: 'role.update',
      roleId: result.id,
      roleName: result.name,
      details: {
        scope: scopeContext.scope,
        changedFields: Object.keys(body),
        permissionCount: rolePerms.length,
        parentRoleId: result.parentRoleId ?? null
      }
    });

    return c.json({
      id: result.id,
      name: result.name,
      description: result.description,
      scope: result.scope,
      isSystem: result.isSystem,
      parentRoleId: result.parentRoleId,
      parentRoleName,
      permissions: rolePerms,
      updatedAt: result.updatedAt
    });
  }
);

// DELETE /roles/:id - Delete custom role
roleRoutes.delete(
  '/:id',
  requirePermission(PERMISSIONS.USERS_DELETE.resource, PERMISSIONS.USERS_DELETE.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const roleId = c.req.param('id');

    // Get role
    const [role] = await db
      .select({
        id: roles.id,
        isSystem: roles.isSystem,
        scope: roles.scope,
        partnerId: roles.partnerId,
        orgId: roles.orgId
      })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);

    if (!role) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Cannot delete system roles
    if (role.isSystem) {
      return c.json({ error: 'Cannot delete system roles' }, 403);
    }

    // Verify ownership
    if (scopeContext.scope === 'partner' && role.partnerId !== scopeContext.partnerId) {
      return c.json({ error: 'Role not found' }, 404);
    }
    if (scopeContext.scope === 'organization' && role.orgId !== scopeContext.orgId) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Check if any users are assigned to this role
    let userCount = 0;
    if (scopeContext.scope === 'partner') {
      const [result] = await db
        .select({ count: count() })
        .from(partnerUsers)
        .where(eq(partnerUsers.roleId, roleId));
      userCount = Number(result?.count || 0);
    } else {
      const [result] = await db
        .select({ count: count() })
        .from(organizationUsers)
        .where(eq(organizationUsers.roleId, roleId));
      userCount = Number(result?.count || 0);
    }

    if (userCount > 0) {
      return c.json(
        {
          error: 'Cannot delete role with assigned users',
          userCount
        },
        400
      );
    }

    // Check if any roles inherit from this role
    const [childRoleCount] = await db
      .select({ count: count() })
      .from(roles)
      .where(eq(roles.parentRoleId, roleId));

    if (Number(childRoleCount?.count || 0) > 0) {
      return c.json(
        {
          error: 'Cannot delete role with child roles that inherit from it',
          childRoleCount: Number(childRoleCount?.count || 0)
        },
        400
      );
    }

    // Delete role permissions and role
    await db.transaction(async (tx) => {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      await tx.delete(roles).where(eq(roles.id, roleId));
    });

    writeRoleAudit(c, auth, scopeContext, {
      action: 'role.delete',
      roleId,
      details: {
        scope: scopeContext.scope
      }
    });

    return c.json({ success: true });
  }
);

// POST /roles/:id/clone - Clone a role as starting point for custom role
roleRoutes.post(
  '/:id/clone',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  zValidator('json', z.object({ name: z.string().min(1).max(100) })),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const roleId = c.req.param('id');
    const { name } = c.req.valid('json');

    // Get source role
    const [sourceRole] = await db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        scope: roles.scope,
        isSystem: roles.isSystem,
        partnerId: roles.partnerId,
        orgId: roles.orgId
      })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);

    if (!sourceRole) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Verify access to source role
    if (!sourceRole.isSystem) {
      if (scopeContext.scope === 'partner' && sourceRole.partnerId !== scopeContext.partnerId) {
        return c.json({ error: 'Role not found' }, 404);
      }
      if (scopeContext.scope === 'organization' && sourceRole.orgId !== scopeContext.orgId) {
        return c.json({ error: 'Role not found' }, 404);
      }
    }

    if (sourceRole.scope !== scopeContext.scope) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Get source role permissions
    const sourcePerms = await db
      .select({
        permissionId: rolePermissions.permissionId
      })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));

    // Create new role
    const roleData: {
      name: string;
      description: string | null;
      scope: 'partner' | 'organization';
      isSystem: boolean;
      partnerId?: string;
      orgId?: string;
    } = {
      name,
      description: sourceRole.description ? `Cloned from ${sourceRole.name}: ${sourceRole.description}` : `Cloned from ${sourceRole.name}`,
      scope: scopeContext.scope,
      isSystem: false
    };

    if (scopeContext.scope === 'partner') {
      roleData.partnerId = scopeContext.partnerId;
    } else {
      roleData.orgId = scopeContext.orgId;
    }

    const result = await db.transaction(async (tx) => {
      const [newRole] = await tx
        .insert(roles)
        .values(roleData)
        .returning();

      if (!newRole) {
        throw new HTTPException(500, { message: 'Failed to clone role' });
      }

      // Copy permissions
      if (sourcePerms.length > 0) {
        await tx.insert(rolePermissions).values(
          sourcePerms.map((perm) => ({
            roleId: newRole.id,
            permissionId: perm.permissionId
          }))
        );
      }

      return newRole;
    });

    // Get permissions for the new role
    const rolePerms = await db
      .select({
        resource: permissions.resource,
        action: permissions.action
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, result.id));

    writeRoleAudit(c, auth, scopeContext, {
      action: 'role.clone',
      roleId: result.id,
      roleName: result.name,
      details: {
        sourceRoleId: sourceRole.id,
        sourceRoleName: sourceRole.name,
        scope: scopeContext.scope,
        permissionCount: rolePerms.length
      }
    });

    return c.json(
      {
        id: result.id,
        name: result.name,
        description: result.description,
        scope: result.scope,
        isSystem: result.isSystem,
        permissions: rolePerms,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      },
      201
    );
  }
);

// GET /roles/:id/users - List users with this role
roleRoutes.get(
  '/:id/users',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const roleId = c.req.param('id');

    // Verify role exists and is accessible
    const [role] = await db
      .select({
        id: roles.id,
        isSystem: roles.isSystem,
        scope: roles.scope,
        partnerId: roles.partnerId,
        orgId: roles.orgId
      })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);

    if (!role) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Verify access to this role
    if (!role.isSystem) {
      if (scopeContext.scope === 'partner' && role.partnerId !== scopeContext.partnerId) {
        return c.json({ error: 'Role not found' }, 404);
      }
      if (scopeContext.scope === 'organization' && role.orgId !== scopeContext.orgId) {
        return c.json({ error: 'Role not found' }, 404);
      }
    }

    if (role.scope !== scopeContext.scope) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Get users with this role
    let usersData;

    if (scopeContext.scope === 'partner') {
      usersData = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          status: users.status,
          lastLoginAt: users.lastLoginAt
        })
        .from(partnerUsers)
        .innerJoin(users, eq(partnerUsers.userId, users.id))
        .where(
          and(
            eq(partnerUsers.partnerId, scopeContext.partnerId),
            eq(partnerUsers.roleId, roleId)
          )
        );
    } else {
      usersData = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          status: users.status,
          lastLoginAt: users.lastLoginAt
        })
        .from(organizationUsers)
        .innerJoin(users, eq(organizationUsers.userId, users.id))
        .where(
          and(
            eq(organizationUsers.orgId, scopeContext.orgId),
            eq(organizationUsers.roleId, roleId)
          )
        );
    }

    return c.json({ data: usersData });
  }
);

// GET /roles/:id/effective-permissions - Get all permissions including inherited ones
roleRoutes.get(
  '/:id/effective-permissions',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    const roleId = c.req.param('id');

    // Get role
    const [role] = await db
      .select({
        id: roles.id,
        name: roles.name,
        isSystem: roles.isSystem,
        scope: roles.scope,
        parentRoleId: roles.parentRoleId,
        partnerId: roles.partnerId,
        orgId: roles.orgId
      })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);

    if (!role) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Verify access to this role
    if (!role.isSystem) {
      if (scopeContext.scope === 'partner' && role.partnerId !== scopeContext.partnerId) {
        return c.json({ error: 'Role not found' }, 404);
      }
      if (scopeContext.scope === 'organization' && role.orgId !== scopeContext.orgId) {
        return c.json({ error: 'Role not found' }, 404);
      }
    }

    if (role.scope !== scopeContext.scope) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Get effective permissions including inherited ones
    const effectivePerms = await getEffectivePermissions(roleId);

    // Build inheritance chain for display
    const inheritanceChain: { id: string; name: string }[] = [];
    let currentRoleId: string | null = role.parentRoleId;

    while (currentRoleId) {
      const [parentRole] = await db
        .select({
          id: roles.id,
          name: roles.name,
          parentRoleId: roles.parentRoleId
        })
        .from(roles)
        .where(eq(roles.id, currentRoleId))
        .limit(1);

      if (parentRole) {
        inheritanceChain.push({ id: parentRole.id, name: parentRole.name });
        currentRoleId = parentRole.parentRoleId;
      } else {
        break;
      }
    }

    return c.json({
      roleId: role.id,
      roleName: role.name,
      inheritanceChain,
      permissions: effectivePerms.map((p) => ({
        resource: p.resource,
        action: p.action,
        inherited: p.inherited,
        sourceRoleId: p.sourceRoleId,
        sourceRoleName: p.sourceRoleName
      }))
    });
  }
);

// GET /roles/permissions/available - Get available resources and actions
roleRoutes.get(
  '/permissions/available',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    return c.json({
      resources: AVAILABLE_RESOURCES,
      actions: AVAILABLE_ACTIONS
    });
  }
);
