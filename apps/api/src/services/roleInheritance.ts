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
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { permissions, rolePermissions, roles } from '../db/schema';

/**
 * Maximum number of ancestors a role may inherit through. Enforced at write
 * time (routes/roles.ts refuses a parent that would exceed it) and at read
 * time (the walk stops here). Keep in step with the descendant bound in the
 * permissions-epoch triggers (migration
 * 2027-01-23-235000-role-inheritance-permissions-epoch.sql).
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

type RoleRow = RoleOwnership & { id: string; name: string; parentRoleId: string | null };

/**
 * The executor the walk reads through: the ambient `db` by default, or a
 * caller's transaction handle so the reads see the same snapshot (and the
 * same RLS GUCs) as the caller's other reads.
 */
export type RoleReadExecutor = Pick<typeof db, 'select'>;

export interface PermissionGrant {
  resource: string;
  action: string;
}

/**
 * One runtime grant of a role, tagged with the BASE role's ownership — the
 * drop-in shape for consumers that used to read
 * `role_permissions ⋈ roles ⋈ permissions WHERE role_id = <member's role>`
 * and then checked the role's scope and owner themselves.
 */
export interface RoleGrantRow extends PermissionGrant {
  roleId: string;
  roleScope: string;
  roleIsSystem: boolean;
  roleOrgId: string | null;
  rolePartnerId: string | null;
}

async function loadRoles(exec: RoleReadExecutor, ids: string[], cache: Map<string, RoleRow | null>): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !cache.has(id));
  if (missing.length === 0) return;
  const columns = {
    id: roles.id,
    name: roles.name,
    scope: roles.scope,
    partnerId: roles.partnerId,
    orgId: roles.orgId,
    isSystem: roles.isSystem,
    parentRoleId: roles.parentRoleId,
  };
  // One role (the runtime hot path: a member's role, then one parent per hop)
  // is a point lookup, the same query shape the walk has always issued.
  if (missing.length === 1) {
    const [row] = await exec.select(columns).from(roles).where(eq(roles.id, missing[0]!)).limit(1);
    cache.set(missing[0]!, row ? ({ ...row, id: missing[0]! } as RoleRow) : null);
    return;
  }
  const rows = await exec.select(columns).from(roles).where(inArray(roles.id, missing));
  for (const row of rows as RoleRow[]) cache.set(row.id, row);
  for (const id of missing) if (!cache.has(id)) cache.set(id, null);
}

interface WalkState {
  roleId: string;
  lineage: RoleLineageEntry[];
  visited: Set<string>;
  child: RoleRow;
}

/**
 * THE walk. Every lineage this module returns comes from here: each base role
 * advances one hop per round, and each round loads the parents it needs in
 * one query, so N roles cost at most MAX_ROLE_INHERITANCE_DEPTH + 1 queries.
 * The checks run in a fixed order per hop (depth, cycle, missing, tenant) and
 * a failed check ends that role's walk only. Returns the base row of each role
 * (null when not found or not visible) with its validated lineage.
 */
async function walkLineages(
  roleIds: string[],
  exec: RoleReadExecutor,
): Promise<Map<string, { base: RoleRow | null; lineage: RoleLineageEntry[] }>> {
  const cache = new Map<string, RoleRow | null>();
  const unique = [...new Set(roleIds)];
  await loadRoles(exec, unique, cache);

  const result = new Map<string, { base: RoleRow | null; lineage: RoleLineageEntry[] }>();
  let active: WalkState[] = [];
  for (const roleId of unique) {
    const base = cache.get(roleId) ?? null;
    if (!base) {
      result.set(roleId, { base: null, lineage: [] });
      continue;
    }
    const lineage: RoleLineageEntry[] = [{ id: roleId, name: base.name }];
    result.set(roleId, { base, lineage });
    active.push({ roleId, lineage, visited: new Set([roleId]), child: base });
  }

  while (active.length > 0) {
    const stepping: WalkState[] = [];
    for (const state of active) {
      const parentId = state.child.parentRoleId;
      if (!parentId) continue;
      if (state.lineage.length > MAX_ROLE_INHERITANCE_DEPTH) {
        console.warn('[roleInheritance] inheritance depth limit reached; ignoring further ancestors', {
          roleId: state.roleId,
          maxDepth: MAX_ROLE_INHERITANCE_DEPTH,
        });
        continue;
      }
      if (state.visited.has(parentId)) {
        console.warn('[roleInheritance] inheritance cycle detected; ignoring the repeated ancestor', {
          roleId: state.roleId,
          repeatedRoleId: parentId,
        });
        continue;
      }
      stepping.push(state);
    }
    await loadRoles(exec, stepping.map((state) => state.child.parentRoleId!), cache);

    const next: WalkState[] = [];
    for (const state of stepping) {
      const parentId = state.child.parentRoleId!;
      const parent = cache.get(parentId) ?? null;
      if (!parent) {
        console.warn('[roleInheritance] parent role not found or not visible; not inherited', {
          roleId: state.roleId,
          missingParentRoleId: parentId,
        });
        continue;
      }
      if (!isPermittedParentRole(state.child, parent)) {
        console.warn('[roleInheritance] parent role outside the child role\'s tenant or scope; not inherited', {
          roleId: state.roleId,
          refusedParentRoleId: parentId,
        });
        continue;
      }
      state.visited.add(parentId);
      state.lineage.push({ id: parentId, name: parent.name });
      state.child = parent;
      next.push(state);
    }
    active = next;
  }

  return result;
}

/**
 * The role followed by its validated ancestors, nearest first. Empty when the
 * role itself is not found (or not visible in the current DB context).
 */
export async function resolveRoleLineage(roleId: string, exec: RoleReadExecutor = db): Promise<RoleLineageEntry[]> {
  return (await walkLineages([roleId], exec)).get(roleId)?.lineage ?? [];
}

/** resolveRoleLineage for many roles at once (same walk, batched per hop). */
export async function resolveRoleLineages(
  roleIds: string[],
  exec: RoleReadExecutor = db,
): Promise<Map<string, RoleLineageEntry[]>> {
  const walked = await walkLineages(roleIds, exec);
  return new Map([...walked].map(([id, entry]) => [id, entry.lineage]));
}

/**
 * The lineage ids whose `role_permissions` rows make up `roleId`'s runtime
 * grants. A role whose row is not visible resolves to no lineage; it then
 * falls back to its own id, which reads exactly the rows it granted before
 * inheritance was honoured (an empty set would let a ceiling pass vacuously).
 */
function grantSourceIds(roleId: string, lineage: RoleLineageEntry[] | undefined): string[] {
  return lineage && lineage.length > 0 ? lineage.map((entry) => entry.id) : [roleId];
}

async function readGrantRows(
  exec: RoleReadExecutor,
  roleIds: string[],
): Promise<Array<{ roleId: string; resource: string; action: string }>> {
  if (roleIds.length === 0) return [];
  return exec
    .select({ roleId: rolePermissions.roleId, resource: permissions.resource, action: permissions.action })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(inArray(rolePermissions.roleId, [...new Set(roleIds)]));
}

/**
 * Each role's runtime grant set — its own `role_permissions` rows plus every
 * validated ancestor's, de-duplicated — keyed by role id. Exactly what
 * getUserPermissions grants a member holding that role. Every requested id
 * has an entry (possibly empty).
 */
export async function getRolesPermissionGrants(
  roleIds: string[],
  exec: RoleReadExecutor = db,
): Promise<Map<string, PermissionGrant[]>> {
  const unique = [...new Set(roleIds)];
  const result = new Map<string, PermissionGrant[]>();
  if (unique.length === 0) return result;
  const lineages = await resolveRoleLineages(unique, exec);
  const sourcesByRole = new Map(unique.map((id) => [id, grantSourceIds(id, lineages.get(id))]));
  const rows = await readGrantRows(exec, [...sourcesByRole.values()].flat());
  const grantsBySource = new Map<string, PermissionGrant[]>();
  for (const row of rows) {
    const list = grantsBySource.get(row.roleId) ?? [];
    list.push({ resource: row.resource, action: row.action });
    grantsBySource.set(row.roleId, list);
  }
  for (const [roleId, sources] of sourcesByRole) {
    const byKey = new Map<string, PermissionGrant>();
    for (const source of sources) {
      for (const grant of grantsBySource.get(source) ?? []) {
        byKey.set(`${grant.resource}:${grant.action}`, grant);
      }
    }
    result.set(roleId, [...byKey.values()]);
  }
  return result;
}

/** getRolesPermissionGrants for one role. */
export async function getRolePermissionGrants(roleId: string, exec: RoleReadExecutor = db): Promise<PermissionGrant[]> {
  return (await getRolesPermissionGrants([roleId], exec)).get(roleId) ?? [];
}

/**
 * Each role's runtime grants as rows tagged with the BASE role's ownership
 * (scope, is_system, owning org/partner), for consumers that check the
 * member's role belongs to the expected tenant before honouring a grant. The
 * ancestors' ownership is not reported: every hop already passed
 * isPermittedParentRole, so the lineage is inside the base role's tenant. A
 * role whose own row is not found or not visible yields no rows, as the old
 * `role_permissions ⋈ roles` inner join did.
 */
export async function getRoleGrantRows(roleIds: string[], exec: RoleReadExecutor = db): Promise<RoleGrantRow[]> {
  const unique = [...new Set(roleIds)];
  if (unique.length === 0) return [];
  const walked = await walkLineages(unique, exec);
  const visible = unique.filter((id) => walked.get(id)?.base);
  if (visible.length === 0) return [];
  const sourcesByRole = new Map(visible.map((id) => [id, grantSourceIds(id, walked.get(id)!.lineage)]));
  const rows = await readGrantRows(exec, [...sourcesByRole.values()].flat());
  const grantsBySource = new Map<string, PermissionGrant[]>();
  for (const row of rows) {
    const list = grantsBySource.get(row.roleId) ?? [];
    list.push({ resource: row.resource, action: row.action });
    grantsBySource.set(row.roleId, list);
  }
  const out: RoleGrantRow[] = [];
  for (const [roleId, sources] of sourcesByRole) {
    const base = walked.get(roleId)!.base!;
    const seen = new Set<string>();
    for (const source of sources) {
      for (const grant of grantsBySource.get(source) ?? []) {
        const key = `${grant.resource}:${grant.action}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          roleId,
          resource: grant.resource,
          action: grant.action,
          roleScope: base.scope,
          roleIsSystem: base.isSystem,
          roleOrgId: base.orgId,
          rolePartnerId: base.partnerId,
        });
      }
    }
  }
  return out;
}

/**
 * Reverse lookup: `grantorRoleIds` (roles that carry some grant in their OWN
 * rows) plus every role that holds that grant through inheritance — i.e.
 * every role whose validated lineage passes through a grantor. Candidates are
 * found by walking `parent_role_id` downwards at most
 * MAX_ROLE_INHERITANCE_DEPTH levels, then each candidate is confirmed by the
 * forward walk, so a role is returned only when getUserPermissions would
 * grant it the grantor's rows (same scope/tenant/cycle/depth rules). The
 * grantors are always returned as given.
 */
export async function expandToInheritingRoleIds(
  grantorRoleIds: string[],
  exec: RoleReadExecutor = db,
): Promise<string[]> {
  const grantors = new Set(grantorRoleIds);
  if (grantors.size === 0) return [];
  const seen = new Set(grantors);
  const candidates: string[] = [];
  let frontier = [...grantors];
  for (let depth = 0; depth < MAX_ROLE_INHERITANCE_DEPTH && frontier.length > 0; depth++) {
    const children = await exec
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.parentRoleId, frontier));
    const next = (children as Array<{ id: string }>).map((c) => c.id).filter((id) => !seen.has(id));
    for (const id of next) seen.add(id);
    candidates.push(...next);
    frontier = [...new Set(next)];
  }
  if (candidates.length === 0) return [...grantors];
  const lineages = await resolveRoleLineages(candidates, exec);
  const inheriting = candidates.filter((id) =>
    (lineages.get(id) ?? []).slice(1).some((entry) => grantors.has(entry.id)),
  );
  return [...grantors, ...new Set(inheriting)];
}

/**
 * Every role that holds `permission` at runtime: the roles whose OWN rows
 * grant it — including the wildcard forms permissionGrantMatches honours
 * (`*` resource and/or `*` action) — plus every role that inherits through
 * one of them (expandToInheritingRoleIds). Global: callers narrow it by
 * membership (org, partner) as they did before.
 */
export async function getRoleIdsHoldingPermission(
  permission: PermissionGrant,
  exec: RoleReadExecutor = db,
): Promise<string[]> {
  const direct = await exec
    .select({ roleId: rolePermissions.roleId })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      and(
        inArray(permissions.resource, [permission.resource, '*']),
        inArray(permissions.action, [permission.action, '*']),
      ),
    );
  return expandToInheritingRoleIds([...new Set((direct as Array<{ roleId: string }>).map((row) => row.roleId))], exec);
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
