/**
 * Role inheritance ("Inherit From", `roles.parent_role_id`) — the ONE walk that
 * runtime permission resolution (services/permissions.ts getUserPermissions),
 * the assignment/creation ceilings (services/roleAssignment.ts,
 * routes/roles.ts) and the role editor's effective-permissions view all use,
 * so the three can never disagree about what a role grants (#9600).
 *
 * A role grants its own `role_permissions` rows plus every row of each
 * ancestor in its lineage. The walk is defensive against bad data, because
 * `parent_role_id` has no FK, no CHECK and no trigger behind it — only the
 * write-time checks in routes/roles.ts:
 *   - cycle-safe: a role id seen twice ends the walk;
 *   - bounded: at most MAX_ROLE_INHERITANCE_DEPTH ancestors are followed;
 *   - tenant-confined: every hop must pass isPermittedParentRole against its
 *     child (same scope; same owning partner/org, or a global built-in
 *     template). A hop that fails ends the walk, so a role can never pick up
 *     another tenant's grants even if a row was written around the API.
 * Every truncation fails closed: the role keeps what was resolved before the
 * bad hop and gains nothing past it.
 *
 * The walk reads `roles` under whatever DB context the caller runs in. The
 * runtime caller (getUserPermissions) already escalates to a context that can
 * see the member's role, and a permitted ancestor is either the same tenant's
 * row or a global template, both visible there. An ancestor hidden by RLS
 * reads as missing and ends the walk (fails closed).
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { permissions, rolePermissions, roles } from '../db/schema';

/**
 * Maximum number of ancestors a role may inherit through. Enforced at write
 * time (routes/roles.ts refuses a parent that would exceed it) and at read
 * time (the walk stops here). Keep in step with the descendant bound in the
 * permissions-epoch triggers (migration
 * 2027-01-17-130000-role-inheritance-permissions-epoch.sql).
 */
export const MAX_ROLE_INHERITANCE_DEPTH = 8;

export interface RoleOwnership {
  scope: string;
  partnerId: string | null;
  orgId: string | null;
  isSystem: boolean;
}

export interface RoleLineageEntry {
  id: string;
  name: string;
}

export interface EffectiveRolePermission {
  resource: string;
  action: string;
  /** false for the role's own rows, true for rows that come from an ancestor. */
  inherited: boolean;
  /** The nearest role in the lineage that carries the row. */
  sourceRoleId: string;
  sourceRoleName: string;
}

/** A built-in template: `is_system` with no owning partner or org (seed.ts). */
export function isGlobalRoleTemplate(role: RoleOwnership): boolean {
  return role.isSystem && role.partnerId === null && role.orgId === null;
}

/**
 * Whether `parent` may be the inheritance parent of `child`. The parent must
 * share the child's scope and be either a global built-in template or a role
 * owned by the child's own partner (partner scope) / org (organization scope).
 * A global template may only inherit from another global template. Checked hop
 * by hop, so the whole lineage stays inside the base role's tenant.
 */
export function isPermittedParentRole(child: RoleOwnership, parent: RoleOwnership): boolean {
  if (parent.scope !== child.scope) return false;
  if (isGlobalRoleTemplate(parent)) return true;
  if (child.scope === 'partner') {
    return parent.partnerId !== null && parent.partnerId === child.partnerId;
  }
  if (child.scope === 'organization') {
    return parent.orgId !== null && parent.orgId === child.orgId;
  }
  return false;
}

type RoleRow = RoleOwnership & { name: string; parentRoleId: string | null };

async function loadRole(roleId: string): Promise<RoleRow | null> {
  const [row] = await db
    .select({
      name: roles.name,
      scope: roles.scope,
      partnerId: roles.partnerId,
      orgId: roles.orgId,
      isSystem: roles.isSystem,
      parentRoleId: roles.parentRoleId,
    })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);
  return (row as RoleRow | undefined) ?? null;
}

/**
 * The role followed by its validated ancestors, nearest first. Empty when the
 * role itself is not found (or not visible in the current DB context).
 */
export async function resolveRoleLineage(roleId: string): Promise<RoleLineageEntry[]> {
  const base = await loadRole(roleId);
  if (!base) return [];

  const lineage: RoleLineageEntry[] = [{ id: roleId, name: base.name }];
  const visited = new Set<string>([roleId]);
  let child: RoleRow = base;

  while (child.parentRoleId) {
    const parentId = child.parentRoleId;
    if (lineage.length > MAX_ROLE_INHERITANCE_DEPTH) {
      console.warn('[roleInheritance] inheritance depth limit reached; ignoring further ancestors', {
        roleId,
        maxDepth: MAX_ROLE_INHERITANCE_DEPTH,
      });
      break;
    }
    if (visited.has(parentId)) {
      console.warn('[roleInheritance] inheritance cycle detected; ignoring the repeated ancestor', {
        roleId,
        repeatedRoleId: parentId,
      });
      break;
    }
    const parent = await loadRole(parentId);
    if (!parent) {
      console.warn('[roleInheritance] parent role not found or not visible; not inherited', {
        roleId,
        missingParentRoleId: parentId,
      });
      break;
    }
    if (!isPermittedParentRole(child, parent)) {
      console.warn('[roleInheritance] parent role outside the child role\'s tenant or scope; not inherited', {
        roleId,
        refusedParentRoleId: parentId,
      });
      break;
    }
    visited.add(parentId);
    lineage.push({ id: parentId, name: parent.name });
    child = parent;
  }

  return lineage;
}

/**
 * The (resource, action) grants of every role in the lineage, deduplicated —
 * the runtime permission set of a member holding `lineageRoleIds[0]`.
 */
export async function getLineagePermissionGrants(
  lineageRoleIds: string[],
): Promise<Array<{ resource: string; action: string }>> {
  if (lineageRoleIds.length === 0) return [];
  const rows = await db
    .select({ resource: permissions.resource, action: permissions.action })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(inArray(rolePermissions.roleId, lineageRoleIds));
  const byKey = new Map<string, { resource: string; action: string }>();
  for (const row of rows) {
    byKey.set(`${row.resource}:${row.action}`, { resource: row.resource, action: row.action });
  }
  return [...byKey.values()];
}

/**
 * The role's effective permissions with provenance, for ceilings and the role
 * editor: its own rows first, then each ancestor's rows that a nearer role
 * did not already grant.
 */
export async function getEffectiveRolePermissionSources(roleId: string): Promise<EffectiveRolePermission[]> {
  // A role row that is not visible still has its own grants read, as before
  // inheritance was honoured: an empty set here would let an assignment
  // ceiling pass vacuously.
  const resolved = await resolveRoleLineage(roleId);
  const lineage = resolved.length > 0 ? resolved : [{ id: roleId, name: '' }];
  const seen = new Set<string>();
  const result: EffectiveRolePermission[] = [];
  for (const [index, entry] of lineage.entries()) {
    const rows = await db
      .select({ resource: permissions.resource, action: permissions.action })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, entry.id));
    for (const row of rows) {
      const key = `${row.resource}:${row.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        resource: row.resource,
        action: row.action,
        inherited: index > 0,
        sourceRoleId: entry.id,
        sourceRoleName: entry.name,
      });
    }
  }
  return result;
}

/**
 * Number of inheritance levels below `roleId` (0 for a role nothing inherits
 * from). Explores at most MAX_ROLE_INHERITANCE_DEPTH + 1 levels — enough to
 * tell whether a new parent would push a descendant past the limit — and is
 * cycle-safe.
 */
export async function getRoleSubtreeHeight(roleId: string): Promise<number> {
  const visited = new Set<string>([roleId]);
  let frontier = [roleId];
  let height = 0;
  while (frontier.length > 0 && height <= MAX_ROLE_INHERITANCE_DEPTH) {
    const children = await db
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.parentRoleId, frontier));
    const next = children.map((c) => c.id).filter((id) => !visited.has(id));
    if (next.length === 0) break;
    for (const id of next) visited.add(id);
    frontier = next;
    height += 1;
  }
  return height;
}
