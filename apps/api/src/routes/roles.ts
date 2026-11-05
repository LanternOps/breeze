import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, or, count, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { roles, permissions, rolePermissions, partnerUsers, organizationUsers } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
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
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { isPgForeignKeyViolation } from '../utils/pgErrors';
import {
  getEffectivePermissions,
  getRoleDetail,
  getRoleEffectivePermissions,
  listRoleUsers,
  listRolesForScope,
  resolvePartnerFocusedOrgId,
  resolveRoleActingScope,
} from '../services/roleDirectory';

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

  if (!canManagePartnerWidePolicies(auth)) {
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
  parentRoleId: z.string().guid().nullable().optional(),
  // Optional target org for a partner-scope caller to mint an ORGANIZATION-scoped
  // role directly (#3524). Without it, a partner admin can only create
  // partner-scoped roles, so the SSO default-role picker — which lists only
  // org-scoped, non-system roles — stays permanently empty. The orgId is
  // validated against the caller's own org allowlist (see the handler) before it
  // re-scopes the creation.
  orgId: z.string().guid().optional(),
  // #8370: the owner axis, stated explicitly by the caller (Partner-Wide First,
  // docs/agents/tenancy-rls.md). Create-only — updateRoleSchema has no such
  // field, so a role never moves between axes. When omitted, the legacy rule
  // applies (orgId present → organization, else the token's own scope), which
  // is what let the web dialog silently mint org roles from the header org.
  ownerScope: z.enum(['partner', 'organization']).optional(),
  // #5317: `roles.force_mfa` — members of this role must have MFA enrolled
  // (enforced in services/mfaPolicy.ts). Not inherited through parentRoleId.
  forceMfa: z.boolean().optional()
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  permissions: z.array(permissionSchema).optional(),
  parentRoleId: z.string().guid().nullable().optional(),
  forceMfa: z.boolean().optional()
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

type RoleAuth = {
  scope: string;
  partnerId: string | null;
  orgId: string | null;
  canAccessOrg: (orgId: string) => boolean;
};


// Resolve the scope a request should ACT under: a partner's validated focused
// org (→ organization scope) if present, else the caller's own token scope.
// Used by the single-scope role endpoints so the whole org-role lifecycle
// (read/edit/clone/delete/users/permissions) is consistent for a focused partner.
async function resolveActingScope(auth: RoleAuth, targetOrgId: string | undefined | null): Promise<ScopeContext> {
  const focusedOrgId = await resolvePartnerFocusedOrgId(auth, targetOrgId);
  return focusedOrgId ? { scope: 'organization', orgId: focusedOrgId } : getScopeContext(auth);
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

  createAuditLogAsync({
    orgId: orgId ?? undefined,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: event.action,
    resourceType: 'role',
    resourceId: event.roleId,
    resourceName: event.roleName,
    details: event.details,
    ipAddress: getTrustedClientIpOrUndefined(c),
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

function validateAssignablePermissions(
  requested: Array<{ resource: string; action: string }>,
  callerPermissions: UserPermissions | null
): string | null {
  if (requested.length === 0) {
    return null;
  }

  if (!callerPermissions) {
    return 'No permissions found';
  }

  for (const permission of requested) {
    if (permission.resource === '*' || permission.action === '*') {
      return 'Wildcard permissions cannot be assigned to custom roles';
    }

    if (!isAssignablePermission(permission)) {
      return `Unknown permission: ${permission.resource}:${permission.action}`;
    }

    if (!hasPermission(callerPermissions, permission.resource, permission.action)) {
      return `Cannot assign permission not held by caller: ${permission.resource}:${permission.action}`;
    }
  }

  return null;
}

async function getAssignedUserIdsForRoles(roleIds: string[], scopeContext: ScopeContext): Promise<string[]> {
  if (roleIds.length === 0) return [];

  const rows = scopeContext.scope === 'partner'
    ? await db
        .select({ userId: partnerUsers.userId })
        .from(partnerUsers)
        .where(and(eq(partnerUsers.partnerId, scopeContext.partnerId), inArray(partnerUsers.roleId, roleIds)))
    : await db
        .select({ userId: organizationUsers.userId })
        .from(organizationUsers)
        .where(and(eq(organizationUsers.orgId, scopeContext.orgId), inArray(organizationUsers.roleId, roleIds)));

  return Array.from(new Set(rows.map((row) => row.userId).filter(Boolean)));
}

async function clearPermissionCachesForUsers(userIds: string[]): Promise<void> {
  for (const userId of new Set(userIds)) {
    await clearPermissionCache(userId);
  }
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


// GET /roles - List all roles (system + custom for scope). W18 (#6789): the
// query lives in services/roleDirectory.ts, shared with the list_roles AI tool.
roleRoutes.get(
  '/',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const scopeContext = getScopeContext(auth);
    return c.json({ data: await listRolesForScope(auth, scopeContext, c.req.query('orgId')) });
  }
);

// POST /roles - Create custom role for organization
roleRoutes.post(
  '/',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  requireMfa(),
  zValidator('json', createRoleSchema),
  async (c) => {
    const auth = c.get('auth');
    let scopeContext = getScopeContext(auth);
    const body = c.req.valid('json');

    // #8370: an explicit owner axis is validated against the caller before any
    // org re-scoping. These checks only narrow what the legacy path already
    // allowed; the partner-wide gate (canManagePartnerWidePolicies, enforced by
    // the router middleware for every partner token) is unchanged.
    if (body.ownerScope === 'partner') {
      if (auth.scope !== 'partner') {
        return c.json({ error: 'Only partner-scope users can create partner roles' }, 403);
      }
      if (body.orgId !== undefined) {
        return c.json({ error: 'orgId must not be sent with ownerScope "partner"' }, 400);
      }
    } else if (body.ownerScope === 'organization' && auth.scope === 'partner' && body.orgId === undefined) {
      return c.json(
        { error: 'orgId is required: send the owning organization as orgId when ownerScope is "organization"' },
        400
      );
    }

    // #3524: a partner admin may target a specific org so the SSO default-role
    // picker (which offers only org-scoped, non-system roles) can be populated.
    // Re-scope the ENTIRE creation to that org — every downstream step (parent
    // validation, RLS insert, audit) then treats it exactly like a native
    // org-scope creation. `resolvePartnerFocusedOrgId` gates the org against the
    // caller's own tree and excludes the hidden quick_support org; the `roles`
    // INSERT RLS policy (`breeze_has_org_access`) backstops it at the DB. A
    // provided-but-invalid org (foreign or quick_support) is a hard 403 rather
    // than a silent fall-through to a partner-scoped role.
    // An org-scope caller naming its OWN org is a no-op, not a partner focus:
    // `RolesPage` sends `orgId` for every org-token user, so treating that as a
    // focus request 403'd org admins out of creating any role at all.
    if (body.orgId !== undefined && !(auth.scope === 'organization' && auth.orgId === body.orgId)) {
      const focusedOrgId = await resolvePartnerFocusedOrgId(auth, body.orgId);
      if (!focusedOrgId) {
        return c.json({ error: 'You do not have access to the specified organization' }, 403);
      }
      scopeContext = { scope: 'organization', orgId: focusedOrgId };
    }

    const callerPermissions = await getCallerPermissions(c, auth);
    const permissionError = validateAssignablePermissions(body.permissions, callerPermissions);
    if (permissionError) {
      return c.json({ error: permissionError }, 403);
    }

    // Validate parent role if provided
    if (body.parentRoleId) {
      const validation = await validateParentRole(body.parentRoleId, scopeContext);
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }
      const parentPermissionError = validateAssignablePermissions(
        await getEffectivePermissions(body.parentRoleId),
        callerPermissions
      );
      if (parentPermissionError) {
        return c.json({ error: parentPermissionError }, 403);
      }
    }

    // Create role
    const roleData: {
      name: string;
      description: string | null;
      scope: 'partner' | 'organization';
      isSystem: boolean;
      forceMfa: boolean;
      parentRoleId?: string | null;
      partnerId?: string;
      orgId?: string;
    } = {
      name: body.name,
      description: body.description || null,
      scope: scopeContext.scope,
      isSystem: false,
      forceMfa: body.forceMfa ?? false,
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
        parentRoleId: result.parentRoleId ?? null,
        forceMfa: result.forceMfa
      }
    });

    return c.json(
      {
        id: result.id,
        name: result.name,
        description: result.description,
        scope: result.scope,
        isSystem: result.isSystem,
        forceMfa: result.forceMfa,
        parentRoleId: result.parentRoleId,
        parentRoleName,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      },
      201
    );
  }
);

// GET /roles/:id - Get role with permissions (services/roleDirectory.ts, W18 #6789)
roleRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const role = await getRoleDetail(c.get('auth'), c.req.param('id')!, c.req.query('orgId'));
    if (!role) {
      return c.json({ error: 'Role not found' }, 404);
    }
    return c.json(role);
  }
);

// PATCH /roles/:id - Update custom role
roleRoutes.patch(
  '/:id',
  requirePermission(PERMISSIONS.USERS_WRITE.resource, PERMISSIONS.USERS_WRITE.action),
  requireMfa(),
  zValidator('json', updateRoleSchema),
  async (c) => {
    const auth = c.get('auth');
    const focusedOrgId = c.req.query('orgId');
    const roleId = c.req.param('id')!;
    const body = c.req.valid('json');
    const callerPermissions = await getCallerPermissions(c, auth);
    if (body.permissions !== undefined) {
      const permissionError = validateAssignablePermissions(body.permissions, callerPermissions);
      if (permissionError) {
        return c.json({ error: permissionError }, 403);
      }
    }

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

    // Verify ownership. The acting scope is derived from the role's own axis,
    // NOT from `?orgId=` — see resolveRoleActingScope. It also refuses any row
    // whose scope disagrees with that axis: `roles` has no scope-axis CHECK
    // constraint, so we never trust the owning-id columns alone.
    const scopeContext = await resolveRoleActingScope(auth, role, focusedOrgId);
    if (!scopeContext) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Validate parent role if being updated
    if (body.parentRoleId !== undefined && body.parentRoleId !== null) {
      const validation = await validateParentRole(body.parentRoleId, scopeContext);
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }
      const parentPermissionError = validateAssignablePermissions(
        await getEffectivePermissions(body.parentRoleId),
        callerPermissions
      );
      if (parentPermissionError) {
        return c.json({ error: parentPermissionError }, 403);
      }

      // Check for circular inheritance
      const wouldBeCircular = await wouldCreateCircularInheritance(roleId, body.parentRoleId);
      if (wouldBeCircular) {
        return c.json({ error: 'Cannot set parent role: would create circular inheritance' }, 400);
      }
    }

    // force_mfa is deliberately NOT a reason to walk descendants: it is not
    // inherited through parentRoleId (services/mfaPolicy.ts reads the member's
    // own role row), so only this role's direct members are affected.
    const affectedRoleIds = new Set<string>([roleId]);
    if (body.permissions !== undefined || body.parentRoleId !== undefined) {
      for (const descendantRoleId of await getDescendantRoleIds(roleId)) {
        affectedRoleIds.add(descendantRoleId);
      }
    }
    const affectedUserIds = await getAssignedUserIdsForRoles([...affectedRoleIds], scopeContext);

    const result = await db.transaction(async (tx) => {
      // Update role fields
      const updates: {
        name?: string;
        description?: string | null;
        parentRoleId?: string | null;
        forceMfa?: boolean;
        updatedAt: Date;
      } = {
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

      if (body.forceMfa !== undefined) {
        updates.forceMfa = body.forceMfa;
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
    await clearPermissionCachesForUsers(affectedUserIds);

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
        parentRoleId: result.parentRoleId ?? null,
        forceMfa: result.forceMfa
      }
    });

    return c.json({
      id: result.id,
      name: result.name,
      description: result.description,
      scope: result.scope,
      isSystem: result.isSystem,
      forceMfa: result.forceMfa,
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
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const focusedOrgId = c.req.query('orgId');
    const roleId = c.req.param('id')!;

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

    // Verify ownership. The acting scope is derived from the role's own axis,
    // NOT from `?orgId=` — see resolveRoleActingScope. It also refuses any row
    // whose scope disagrees with that axis: `roles` has no scope-axis CHECK
    // constraint, so we never trust the owning-id columns alone.
    const scopeContext = await resolveRoleActingScope(auth, role, focusedOrgId);
    if (!scopeContext) {
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

    // Delete role permissions and role. access_review_items.role_id has no
    // ON DELETE action on purpose: a completed review's items (decisions,
    // notes, reviewer) are evidence and must not vanish because the reviewed
    // role was deleted afterwards. The FK is the check (an RLS-scoped count
    // here could miss items on reviews the caller cannot see), so map its
    // violation to a clean 409.
    try {
      await db.transaction(async (tx) => {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        await tx.delete(roles).where(eq(roles.id, roleId));
      });
    } catch (err) {
      if (isPgForeignKeyViolation(err, 'access_review_items_role_id_roles_id_fk')) {
        return c.json({ error: 'Role is referenced by access reviews' }, 409);
      }
      throw err;
    }

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
  requireMfa(),
  zValidator('json', z.object({ name: z.string().min(1).max(100), description: z.string().optional() })),
  async (c) => {
    const auth = c.get('auth');
    const focusedOrgId = c.req.query('orgId');
    const roleId = c.req.param('id')!;
    const { name, description } = c.req.valid('json');
    const callerPermissions = await getCallerPermissions(c, auth);

    // Get source role
    const [sourceRole] = await db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        scope: roles.scope,
        isSystem: roles.isSystem,
        forceMfa: roles.forceMfa,
        partnerId: roles.partnerId,
        orgId: roles.orgId
      })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);

    if (!sourceRole) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Verify access to source role. The acting scope is derived from the source
    // role's own axis, NOT from `?orgId=` — see resolveRoleActingScope. The
    // clone is then created on that same axis.
    const scopeContext = await resolveRoleActingScope(auth, sourceRole, focusedOrgId);
    if (!scopeContext) {
      return c.json({ error: 'Role not found' }, 404);
    }

    // Get source role permissions
    const sourcePerms = await db
      .select({
        permissionId: rolePermissions.permissionId,
        resource: permissions.resource,
        action: permissions.action
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, roleId));
    const permissionError = validateAssignablePermissions(sourcePerms, callerPermissions);
    if (permissionError) {
      return c.json({ error: permissionError }, 403);
    }

    // Create new role
    const roleData: {
      name: string;
      description: string | null;
      scope: 'partner' | 'organization';
      isSystem: boolean;
      forceMfa: boolean;
      partnerId?: string;
      orgId?: string;
    } = {
      name,
      // #9603: never the source's text or server-written English; the clone dialog
      // sends its own localized, editable description (null when none is given).
      description: description ?? null,
      scope: scopeContext.scope,
      isSystem: false,
      // #5317: a clone keeps the source's MFA requirement — cloning the
      // force-MFA Partner Admin role must not silently drop it. The clone is a
      // custom role, so the caller can turn it off afterwards via PATCH.
      forceMfa: sourceRole.forceMfa
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
        permissionCount: rolePerms.length,
        forceMfa: result.forceMfa
      }
    });

    return c.json(
      {
        id: result.id,
        name: result.name,
        description: result.description,
        scope: result.scope,
        isSystem: result.isSystem,
        forceMfa: result.forceMfa,
        permissions: rolePerms,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      },
      201
    );
  }
);

// GET /roles/:id/users - List users with this role (services/roleDirectory.ts, W18 #6789)
roleRoutes.get(
  '/:id/users',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const usersData = await listRoleUsers(c.get('auth'), c.req.param('id')!, c.req.query('orgId'));
    if (!usersData) {
      return c.json({ error: 'Role not found' }, 404);
    }
    return c.json({ data: usersData });
  }
);

// GET /roles/:id/effective-permissions - Get all permissions including inherited
// ones (services/roleDirectory.ts, W18 #6789)
roleRoutes.get(
  '/:id/effective-permissions',
  requirePermission(PERMISSIONS.USERS_READ.resource, PERMISSIONS.USERS_READ.action),
  async (c) => {
    const body = await getRoleEffectivePermissions(c.get('auth'), c.req.param('id')!, c.req.query('orgId'));
    if (!body) {
      return c.json({ error: 'Role not found' }, 404);
    }
    return c.json(body);
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
