/**
 * Role directory reads (full-control W18, #6789): the queries behind
 * `GET /roles`, `GET /roles/:id`, `GET /roles/:id/users` and
 * `GET /roles/:id/effective-permissions`, lifted out of routes/roles.ts so the
 * route and the `list_roles` AI tool run the same code.
 *
 * The `roleRoutes.use('*')` gate (`canManagePartnerWidePolicies` for a partner
 * token) moves with them: the `*ForCaller` entry points apply it, so a
 * selected-org partner technician reading roles through the tool is refused
 * exactly as REST refuses them (W18 plan, Review Focus 1). A role's acting
 * scope still comes from the role row, never from a focused org id alone
 * (`resolveRoleActingScope`).
 */
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { organizationUsers, organizations, partnerUsers, permissions, rolePermissions, roles, users } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { getScopeContext, type ScopeContext } from './roleAssignment';
import { isHiddenOrgType } from './unassignedPool/visibility';
import {
  FULL_PARTNER_ACCESS_REQUIRED,
  PARTNER_CONTEXT_REQUIRED,
  SCOPE_CONTEXT_REQUIRED,
  type DirectoryRefusal,
  type DirectoryResult,
} from './userDirectory';

export type RoleAuth = {
  scope: string;
  partnerId: string | null;
  orgId: string | null;
  canAccessOrg: (orgId: string) => boolean;
  partnerOrgAccess?: AuthContext['partnerOrgAccess'];
};

const ROLE_NOT_FOUND: DirectoryRefusal = { ok: false, code: 'NOT_FOUND', message: 'Role not found' };

/**
 * The `roleRoutes.use('*')` partner gate plus `getScopeContext`, as a result
 * instead of a thrown HTTPException. Same order and messages as the route.
 */
export function resolveRoleDirectoryScope(auth: RoleAuth): { ok: true; scopeContext: ScopeContext } | DirectoryRefusal {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { ok: false, code: 'FORBIDDEN', message: PARTNER_CONTEXT_REQUIRED };
    if (!canManagePartnerWidePolicies({ scope: 'partner', partnerOrgAccess: auth.partnerOrgAccess })) {
      return { ok: false, code: 'FORBIDDEN', message: FULL_PARTNER_ACCESS_REQUIRED };
    }
    return { ok: true, scopeContext: { scope: 'partner', partnerId: auth.partnerId } };
  }
  if (auth.scope === 'organization' && auth.orgId) {
    return { ok: true, scopeContext: { scope: 'organization', orgId: auth.orgId } };
  }
  return { ok: false, code: 'FORBIDDEN', message: SCOPE_CONTEXT_REQUIRED };
}

// #3524: a partner admin may act on a single org INSIDE THEIR TREE by naming it
// — create passes it as `body.orgId`, every other endpoint via the `?orgId=`
// the web client injects for the focused org. This returns that org id only when
// it is a legitimate target, so partner admins can fully create/list/manage that
// org's roles and thereby populate (and maintain) the SSO org-provider
// default-role picker. Two gates: `canAccessOrg` (for a partner this resolves to
// exactly their own orgs) and exclusion of the hidden `quick_support` org, which
// is internal-only and must never hold user-facing roles or SSO providers. The
// roles RLS policies (`breeze_has_org_access`) backstop every query at the DB.
// Returns null (→ caller keeps its token scope) for a non-partner caller, a
// missing/foreign org, or the quick_support org.
export async function resolvePartnerFocusedOrgId(
  auth: RoleAuth,
  targetOrgId: string | undefined | null
): Promise<string | null> {
  if (auth.scope !== 'partner' || !targetOrgId || !auth.canAccessOrg(targetOrgId)) {
    return null;
  }
  const [org] = await db
    .select({ type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, targetOrgId))
    .limit(1);
  if (!org || isHiddenOrgType(org.type)) {
    return null;
  }
  return targetOrgId;
}

// Resolve the scope for a request that targets ONE KNOWN ROLE, from that role's
// own axis rather than from `?orgId=`.
//
// Why not just `resolveActingScope(auth, c.req.query('orgId'))`: `fetchWithAuth`
// injects the focused org into EVERY request (apps/web/src/stores/auth.ts) and
// `orgStore` auto-selects one on load, so a partner admin effectively always
// sends an orgId. Deriving the scope from that param alone flipped the acting
// scope to `organization` for every request, and the `role.scope !==
// scopeContext.scope` guard in the routes/roles.ts handlers then 404'd every partner-scoped role — while
// `GET /roles` happily kept listing them. The role itself is the only reliable
// statement of which axis a request is operating on.
//
// Returns null when the caller may not act on this role at all; every caller
// turns that into the same 404 the ownership checks already produce.
export async function resolveRoleActingScope(
  auth: RoleAuth,
  role: { scope: string; isSystem: boolean; partnerId: string | null; orgId: string | null },
  focusedOrgId: string | undefined | null
): Promise<ScopeContext | null> {
  const tokenScope = getScopeContext(auth);

  if (role.scope === 'partner') {
    // Only a partner token can act on the partner axis, and only on its own
    // partner's roles. A focused org must not drag us off this axis.
    if (tokenScope.scope !== 'partner') return null;
    if (!role.isSystem && role.partnerId !== tokenScope.partnerId) return null;
    return tokenScope;
  }

  if (role.scope === 'organization') {
    if (tokenScope.scope === 'organization') {
      // An org caller cannot change organization context, so its TOKEN org is
      // authoritative and a stale or hand-supplied `?orgId=` must never be able
      // to deny it. A system org role (org_id null) resolves in the token org;
      // a concrete one must belong to it.
      if (role.isSystem) return tokenScope;
      return role.orgId === tokenScope.orgId ? tokenScope : null;
    }

    // Partner token: the request must still NAME the org it is acting on, and
    // for a concrete org role that name has to match the role's own org.
    //
    // Deriving the org from `role.org_id` alone would let a focused org be
    // silently overridden by a role id: a partner focused on org A could send
    // org B's role id and PATCH/DELETE/clone against B, which is the wrong
    // customer even though the partner has umbrella access to both. Requiring
    // the match keeps the request bound to the org it names, which is what the
    // role routes' focused-org handling promises (routes/roles.ts).
    const resolved = await resolvePartnerFocusedOrgId(auth, focusedOrgId);
    if (!resolved) return null;
    if (!role.isSystem && role.orgId !== resolved) return null;
    return { scope: 'organization', orgId: resolved };
  }

  return null;
}

export type EffectivePermission = { resource: string; action: string; inherited: boolean; sourceRoleId: string; sourceRoleName: string };

// Helper to get effective permissions (own + inherited from parent chain)
export async function getEffectivePermissions(
  roleId: string,
  visited: Set<string> = new Set()
): Promise<EffectivePermission[]> {
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

  const result: EffectivePermission[] = directPerms.map((p) => ({
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

/** `GET /roles` for an already-gated token scope (system + custom roles of the scope). */
export async function listRolesForScope(auth: RoleAuth, scopeContext: ScopeContext, requestedOrgId: string | undefined | null) {
  // #3524: when a PARTNER admin is focused on one org (the web client injects
  // ?orgId=), also surface that org's org-scoped roles. Without this the role a
  // partner just created for the org is invisible here, so the SSO org-provider
  // default-role picker — which populates from GET /roles — stays empty and the
  // feature is inert. `resolvePartnerFocusedOrgId` validates the org against the
  // caller's tree and excludes the hidden quick_support org; the roles SELECT
  // RLS policy (breeze_has_org_access) backstops the query at the DB.
  const focusedOrgId = await resolvePartnerFocusedOrgId(auth, requestedOrgId);

  const roleColumns = {
    id: roles.id,
    name: roles.name,
    description: roles.description,
    scope: roles.scope,
    isSystem: roles.isSystem,
    forceMfa: roles.forceMfa,
    parentRoleId: roles.parentRoleId,
    createdAt: roles.createdAt,
    updatedAt: roles.updatedAt
  };

  let rolesData;

  if (scopeContext.scope === 'partner') {
    const partnerRoles = await db
      .select(roleColumns)
      .from(roles)
      .where(
        and(
          eq(roles.scope, 'partner'),
          or(eq(roles.isSystem, true), eq(roles.partnerId, scopeContext.partnerId))
        )
      );

    if (focusedOrgId) {
      const orgRoles = await db
        .select(roleColumns)
        .from(roles)
        .where(
          and(
            eq(roles.scope, 'organization'),
            or(eq(roles.isSystem, true), eq(roles.orgId, focusedOrgId))
          )
        );
      rolesData = [...partnerRoles, ...orgRoles];
    } else {
      rolesData = partnerRoles;
    }
  } else {
    rolesData = await db
      .select(roleColumns)
      .from(roles)
      .where(
        and(
          eq(roles.scope, 'organization'),
          or(eq(roles.isSystem, true), eq(roles.orgId, scopeContext.orgId))
        )
      );
  }

  // Get user counts for each role. Partner-scoped roles count partner_users;
  // org-scoped roles (the focused-org set, #3524) count organization_users for
  // that org — merged so every role reports the right membership.
  const partnerRoleIds = rolesData.filter((r) => r.scope === 'partner').map((r) => r.id);
  const orgRoleIds = rolesData.filter((r) => r.scope === 'organization').map((r) => r.id);

  // `count` is every membership row; `activeCount` only those whose user
  // is status='active' — the set the AI-agent recipient resolver
  // (services/aiAgents/recipients.ts) can actually notify, so the agent
  // forms can flag a role that would fail act mode's recipient check.
  const userCounts: { roleId: string; count: number; activeCount: number }[] = [];

  if (scopeContext.scope === 'partner') {
    if (partnerRoleIds.length > 0) {
      const counts = await db
        .select({ roleId: partnerUsers.roleId, count: count(), activeCount: sql<number>`count(*) filter (where exists (select 1 from users u where u.id = ${partnerUsers.userId} and u.status = 'active'))` })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.partnerId, scopeContext.partnerId),
            inArray(partnerUsers.roleId, partnerRoleIds)
          )
        )
        .groupBy(partnerUsers.roleId);
      userCounts.push(...counts.map((row) => ({ roleId: row.roleId, count: Number(row.count), activeCount: Number(row.activeCount ?? 0) })));
    }
    if (focusedOrgId && orgRoleIds.length > 0) {
      const counts = await db
        .select({ roleId: organizationUsers.roleId, count: count(), activeCount: sql<number>`count(*) filter (where exists (select 1 from users u where u.id = ${organizationUsers.userId} and u.status = 'active'))` })
        .from(organizationUsers)
        .where(
          and(
            eq(organizationUsers.orgId, focusedOrgId),
            inArray(organizationUsers.roleId, orgRoleIds)
          )
        )
        .groupBy(organizationUsers.roleId);
      userCounts.push(...counts.map((row) => ({ roleId: row.roleId, count: Number(row.count), activeCount: Number(row.activeCount ?? 0) })));
    }
  } else if (orgRoleIds.length > 0) {
    const counts = await db
      .select({ roleId: organizationUsers.roleId, count: count(), activeCount: sql<number>`count(*) filter (where exists (select 1 from users u where u.id = ${organizationUsers.userId} and u.status = 'active'))` })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.orgId, scopeContext.orgId),
          inArray(organizationUsers.roleId, orgRoleIds)
        )
      )
      .groupBy(organizationUsers.roleId);
    userCounts.push(...counts.map((row) => ({ roleId: row.roleId, count: Number(row.count), activeCount: Number(row.activeCount ?? 0) })));
  }

  const userCountMap = new Map(userCounts.map((uc) => [uc.roleId, uc.count]));
  const activeUserCountMap = new Map(userCounts.map((uc) => [uc.roleId, uc.activeCount]));

  // Build a map of role IDs to names for parent role lookup
  const roleNameMap = new Map(rolesData.map((r) => [r.id, r.name]));

  return rolesData.map((role) => ({
    ...role,
    parentRoleName: role.parentRoleId ? roleNameMap.get(role.parentRoleId) || null : null,
    userCount: userCountMap.get(role.id) || 0,
    activeUserCount: activeUserCountMap.get(role.id) || 0
  }));
}

/** `GET /roles/:id` body, or null when the role is missing or not the caller's to read. */
export async function getRoleDetail(auth: RoleAuth, roleId: string, focusedOrgId: string | undefined | null) {
  // Get role
  const [role] = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      scope: roles.scope,
      isSystem: roles.isSystem,
      forceMfa: roles.forceMfa,
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
    return null;
  }

  // Verify access to this role. The acting scope is derived from the role's
  // own axis, NOT from `?orgId=` — see resolveRoleActingScope.
  const scopeContext = await resolveRoleActingScope(auth, role, focusedOrgId);
  if (!scopeContext) {
    return null;
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

  return {
    id: role.id,
    name: role.name,
    description: role.description,
    scope: role.scope,
    isSystem: role.isSystem,
    forceMfa: role.forceMfa,
    parentRoleId: role.parentRoleId,
    parentRoleName,
    permissions: rolePerms,
    userCount,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt
  };
}

/** `GET /roles/:id/users` rows, or null when the role is missing or not the caller's to read. */
export async function listRoleUsers(auth: RoleAuth, roleId: string, focusedOrgId: string | undefined | null) {
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
    return null;
  }

  // Verify access to this role. The acting scope is derived from the role's
  // own axis, NOT from `?orgId=` — see resolveRoleActingScope.
  const scopeContext = await resolveRoleActingScope(auth, role, focusedOrgId);
  if (!scopeContext) {
    return null;
  }

  // Get users with this role
  if (scopeContext.scope === 'partner') {
    return db
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
  }

  return db
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

/** `GET /roles/:id/effective-permissions` body, or null when the role is missing or not the caller's to read. */
export async function getRoleEffectivePermissions(auth: RoleAuth, roleId: string, focusedOrgId: string | undefined | null) {
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
    return null;
  }

  // Verify access to this role. The acting scope is derived from the role's
  // own axis, NOT from `?orgId=` — see resolveRoleActingScope.
  const scopeContext = await resolveRoleActingScope(auth, role, focusedOrgId);
  if (!scopeContext) {
    return null;
  }

  // Get effective permissions including inherited ones
  const effectivePerms = await getEffectivePermissions(roleId);

  // Build inheritance chain for display. `seen` stops a corrupt parent cycle
  // from looping forever (validateParentRole refuses one on write).
  const inheritanceChain: { id: string; name: string }[] = [];
  const seen = new Set<string>([role.id]);
  let currentRoleId: string | null = role.parentRoleId;

  while (currentRoleId && !seen.has(currentRoleId)) {
    seen.add(currentRoleId);
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

  return {
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
  };
}

type RoleListRow = Awaited<ReturnType<typeof listRolesForScope>>[number];
type RoleDetail = NonNullable<Awaited<ReturnType<typeof getRoleDetail>>>;
type RoleUserRow = NonNullable<Awaited<ReturnType<typeof listRoleUsers>>>[number];
type RoleEffectivePermissions = NonNullable<Awaited<ReturnType<typeof getRoleEffectivePermissions>>>;

const FOCUSED_ORG_NOT_FOUND: DirectoryRefusal = { ok: false, code: 'NOT_FOUND', message: 'Organization not found or access denied' };

/**
 * The tool's gate: the router gate, then a named org that the caller cannot
 * focus on. REST silently ignores an unusable `?orgId=` (the web client sends
 * one on every request); the tool refuses it, so the model is never told "org X
 * has no custom roles" when it was simply not allowed to look (W18 review).
 */
async function resolveToolScope(auth: RoleAuth, focusedOrgId: string | null | undefined): Promise<{ ok: true; scopeContext: ScopeContext } | DirectoryRefusal> {
  const gate = resolveRoleDirectoryScope(auth);
  if (!gate.ok || !focusedOrgId) return gate;
  if (gate.scopeContext.scope === 'organization') {
    return focusedOrgId === gate.scopeContext.orgId ? gate : FOCUSED_ORG_NOT_FOUND;
  }
  return (await resolvePartnerFocusedOrgId(auth, focusedOrgId)) ? gate : FOCUSED_ORG_NOT_FOUND;
}

/** `GET /roles` with the router gate applied: the AI tool's entry point. */
export async function listRolesForCaller(auth: RoleAuth, focusedOrgId?: string | null): Promise<DirectoryResult<RoleListRow[]>> {
  const gate = await resolveToolScope(auth, focusedOrgId);
  if (!gate.ok) return gate;
  return { ok: true, value: await listRolesForScope(auth, gate.scopeContext, focusedOrgId) };
}

export async function getRoleDetailForCaller(auth: RoleAuth, roleId: string, focusedOrgId?: string | null): Promise<DirectoryResult<RoleDetail>> {
  const gate = await resolveToolScope(auth, focusedOrgId);
  if (!gate.ok) return gate;
  const value = await getRoleDetail(auth, roleId, focusedOrgId);
  return value ? { ok: true, value } : ROLE_NOT_FOUND;
}

export async function listRoleUsersForCaller(auth: RoleAuth, roleId: string, focusedOrgId?: string | null): Promise<DirectoryResult<RoleUserRow[]>> {
  const gate = await resolveToolScope(auth, focusedOrgId);
  if (!gate.ok) return gate;
  const value = await listRoleUsers(auth, roleId, focusedOrgId);
  return value ? { ok: true, value } : ROLE_NOT_FOUND;
}

export async function getRoleEffectivePermissionsForCaller(auth: RoleAuth, roleId: string, focusedOrgId?: string | null): Promise<DirectoryResult<RoleEffectivePermissions>> {
  const gate = await resolveToolScope(auth, focusedOrgId);
  if (!gate.ok) return gate;
  const value = await getRoleEffectivePermissions(auth, roleId, focusedOrgId);
  return value ? { ok: true, value } : ROLE_NOT_FOUND;
}
