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
 * behavior. routes/users.test.ts only asserts on the resulting HTTP status
 * (403) and that db.update was never called for the rejected assignment — it
 * does not pin any message string. The actual byte-identity safety net is
 * roleAssignment.test.ts, which asserts on the returned strings directly.
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
 * Ceiling check body, shared by `checkRolePermissionCeiling` and
 * `validateAssignableRole`. Kept module-private (not exported) so nothing
 * outside this file can substitute a `rolePermissions` array that doesn't
 * match what the role actually carries — see `checkRolePermissionCeiling`'s
 * docstring for why that matters. `rolePermissions` is always the real,
 * freshly (or singly) resolved effective-permissions array for `role`, never
 * caller-supplied.
 */
async function applyCeiling(
  callerPermissions: UserPermissions | null,
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>,
  rolePermissions: Array<{ resource: string; action: string }>
): Promise<string | null> {
  if (rolePermissions.length === 0) {
    return null;
  }

  if (!callerPermissions) {
    return 'No permissions found';
  }

  for (const permission of rolePermissions) {
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
 * Full ceiling check against an ALREADY-RESOLVED caller permission set. Walks
 * the role's effective permissions itself — there is deliberately no
 * caller-supplied override for that walk. (An earlier revision took an
 * optional `precomputedRolePermissions` 3rd arg; it was removed because it let
 * a caller short-circuit the ceiling with an unvalidated array — e.g. an empty
 * array would report ANY role, including a wildcard system role, as
 * assignable without ever reading its real permissions, and it did so before
 * the null-caller guard even ran. `validateAssignableRole` still gets the
 * single-walk sharing it needs for the I7 short-circuit and to keep the
 * db.select call count/ordering routes/users.test.ts's mock queues assume —
 * it does so via the private `applyCeiling` helper below, not through this
 * exported function's signature.)
 */
export async function checkRolePermissionCeiling(
  callerPermissions: UserPermissions | null,
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>
): Promise<string | null> {
  return applyCeiling(callerPermissions, role, await getEffectiveRolePermissions(role.id));
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
  return applyCeiling(callerPermissions, role, rolePermissionsForAssignment);
}
