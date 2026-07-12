import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { roles, permissions, rolePermissions } from '../db/schema';
import {
  getUserPermissions,
  hasPermission,
  isAssignablePermission,
  type UserPermissions,
} from './permissions';

/**
 * Canonical assignable-role validation. Lifted VERBATIM out of routes/users.ts
 * (where it was module-private) so SSO default-role configuration and JIT
 * provisioning enforce the SAME permission-subset ceiling as ordinary user
 * administration (SR2-10). Do not fork a second copy: routes/users.ts and
 * routes/sso.ts both consume this module.
 *
 * Every returned message string is byte-identical to the pre-extraction
 * behavior — routes/users.test.ts asserts on them.
 *
 * DB CONTEXT: these functions use the ambient `db`. routes/users.ts calls them
 * inside the authenticated request's RLS context (correct). A caller with NO
 * request context — the unauthenticated /sso/callback — must wrap the call in
 * withSystemDbAccessContext itself.
 */

export type ScopeContext =
  | { scope: 'partner'; partnerId: string }
  | { scope: 'organization'; orgId: string };

export interface AuthLike {
  user: { id: string };
  scope: string;
  partnerId: string | null;
  orgId: string | null;
}

export interface AssignableRoleRow {
  id: string;
  scope: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  parentRoleId: string | null;
  partnerId: string | null;
  orgId: string | null;
}

export function getScopeContext(auth: { scope: string; partnerId: string | null; orgId: string | null }): ScopeContext {
  if (auth.scope === 'partner' && auth.partnerId) {
    return { scope: 'partner', partnerId: auth.partnerId };
  }

  if (auth.scope === 'organization' && auth.orgId) {
    return { scope: 'organization', orgId: auth.orgId };
  }

  throw new HTTPException(403, { message: 'Partner or organization context required' });
}

export async function getScopedRole(roleId: string, scopeContext: ScopeContext): Promise<AssignableRoleRow | null> {
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
    return role as AssignableRoleRow;
  }

  if (scopeContext.scope === 'partner' && role.partnerId === scopeContext.partnerId) {
    return role as AssignableRoleRow;
  }

  if (scopeContext.scope === 'organization' && role.orgId === scopeContext.orgId) {
    return role as AssignableRoleRow;
  }

  return null;
}

export async function getEffectiveRolePermissions(
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

export async function getCallerPermissions(
  c: any,
  auth: AuthLike
): Promise<UserPermissions | null> {
  const existing = c?.get?.('permissions') as UserPermissions | undefined;
  if (existing) return existing;

  return getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined
  });
}

/**
 * Caller-INDEPENDENT structural checks: a custom role may not carry wildcard
 * permissions, and every permission must be a known one. This is the subset of
 * the ceiling check that can still be applied when no caller identity is
 * available (SSO JIT against a provider with no resolvable configurer).
 */
export async function checkRoleStructure(
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>
): Promise<string | null> {
  const rolePermissionsForAssignment = await getEffectiveRolePermissions(role.id);
  if (rolePermissionsForAssignment.length === 0) {
    return null;
  }

  for (const permission of rolePermissionsForAssignment) {
    if (permission.resource === '*' || permission.action === '*') {
      if (!role.isSystem) {
        return 'Custom roles with wildcard permissions cannot be assigned';
      }
      continue;
    }
    if (!isAssignablePermission(permission)) {
      return `Role contains unknown permission: ${permission.resource}:${permission.action}`;
    }
  }

  return null;
}

/**
 * Full ceiling check against an ALREADY-RESOLVED caller permission set. Returns
 * an error message string, or null when the role is assignable.
 *
 * `precomputedRolePermissions` lets a caller that has already walked the
 * role's effective permissions (validateAssignableRole's short-circuit check
 * does exactly that) pass the result straight through instead of paying for a
 * second recursive role walk. This is the "thread the resolved array in as an
 * optional 3rd arg" escape hatch — required, not cosmetic: without it,
 * validateAssignableRole issues one extra pair of db.select calls per
 * invocation, which desyncs the exact call-count the existing
 * routes/users.test.ts mock queues assume (a mocked test asserting a specific
 * sequence of `db.select` return values), turning an expected 403 into a 500.
 */
export async function checkRolePermissionCeiling(
  callerPermissions: UserPermissions | null,
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>,
  precomputedRolePermissions?: Array<{ resource: string; action: string }>
): Promise<string | null> {
  const rolePermissionsForAssignment = precomputedRolePermissions ?? await getEffectiveRolePermissions(role.id);
  if (rolePermissionsForAssignment.length === 0) {
    return null;
  }

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

/**
 * Behavior-preserving façade retained for routes/users.ts.
 *
 * ORDER IS LOAD-BEARING. The original resolved the ROLE's effective permissions
 * first and early-returned null on an empty set, only THEN touching
 * getCallerPermissions. Calling getCallerPermissions unconditionally would make
 * a permission-less role trigger a getUserPermissions resolution that never ran
 * before — which on the system-scope path opens a fresh system transaction
 * (services/permissions.ts:135). So: short-circuit FIRST, resolve the caller
 * SECOND.
 */
export async function validateAssignableRole(
  c: any,
  auth: AuthLike,
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>
): Promise<string | null> {
  const rolePermissionsForAssignment = await getEffectiveRolePermissions(role.id);
  if (rolePermissionsForAssignment.length === 0) {
    return null; // no caller resolution — matches the original's side effects exactly
  }
  const callerPermissions = await getCallerPermissions(c, auth);
  return checkRolePermissionCeiling(callerPermissions, role, rolePermissionsForAssignment);
}
