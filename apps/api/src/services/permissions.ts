import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { roles, permissions, rolePermissions, partnerUsers, organizationUsers } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getRedis } from './redis';
import { PERMISSION_GRANTS } from '@breeze/shared';

export interface Permission {
  resource: string;
  action: string;
}

export interface UserPermissions {
  permissions: Permission[];
  partnerId: string | null;
  orgId: string | null;
  roleId: string;
  scope: 'system' | 'partner' | 'organization';
  orgAccess?: 'all' | 'selected' | 'none';
  allowedOrgIds?: string[];
  allowedSiteIds?: string[];
}

type PermissionCacheVersions = {
  globalVersion: string;
  userVersion: string;
};

type PermissionCacheEntry = {
  userPerms: UserPermissions;
  expiresAt: number;
  versions: PermissionCacheVersions | null;
};

// Local hot cache. Redis version keys provide cross-process invalidation when available.
const permissionCache = new Map<string, PermissionCacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const PERMISSION_CACHE_GLOBAL_VERSION_KEY = 'permission-cache:version';
const PERMISSION_CACHE_USER_VERSION_PREFIX = 'permission-cache:user-version:';

function userPermissionVersionKey(userId: string): string {
  return `${PERMISSION_CACHE_USER_VERSION_PREFIX}${userId}`;
}

async function getPermissionCacheVersions(userId: string): Promise<PermissionCacheVersions | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const [globalVersion, userVersion] = await redis.mget(
      PERMISSION_CACHE_GLOBAL_VERSION_KEY,
      userPermissionVersionKey(userId),
    );
    return {
      globalVersion: globalVersion ?? '0',
      userVersion: userVersion ?? '0',
    };
  } catch (error) {
    console.error('[permissions] Redis permission-cache version read failed:', error);
    return null;
  }
}

function cacheVersionsMatch(
  cached: PermissionCacheVersions | null,
  current: PermissionCacheVersions | null,
): boolean {
  if (!cached || !current) return cached === current;
  return cached.globalVersion === current.globalVersion
    && cached.userVersion === current.userVersion;
}

async function bumpSharedPermissionCacheVersion(userId?: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const key = userId
    ? userPermissionVersionKey(userId)
    : PERMISSION_CACHE_GLOBAL_VERSION_KEY;

  try {
    await redis.incr(key);
  } catch (error) {
    console.error('[permissions] Redis permission-cache invalidation failed:', error);
  }
}

export async function getUserPermissions(
  userId: string,
  context: { partnerId?: string; orgId?: string }
): Promise<UserPermissions | null> {
  const cacheKey = userId + ':' + (context.partnerId || '') + ':' + (context.orgId || '');
  const versions = await getPermissionCacheVersions(userId);
  const cached = permissionCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now() && cacheVersionsMatch(cached.versions, versions)) {
    return cached.userPerms;
  }

  // The membership/role reads below hit RLS-protected tables (organization_users,
  // partner_users, role_permissions). If they run under a context that can't SEE the
  // role row, forced RLS silently filters them to 0 rows → a spurious `null`
  // (→ 403 / "no role assigned") instead of the real permission set. Resolving a
  // user's role is an IDENTITY question, not a tenant-data one, so it must not be
  // filtered by the request's tenant visibility. Two failure classes:
  //   - #1375/#1448: NO ambient context (contextless pay-link route) → bare breeze_app
  //     pool, RLS denies, cold-cache 403.
  //   - #2019: a NARROWER ambient context — an org-scoped MCP/API-key request runs
  //     inside withDbAccessContext with scope='organization' + accessiblePartnerIds=[]
  //     (apiKeyAuth withholds partner-axis visibility from manual keys). A Partner
  //     Admin's role lives in partner_users (FORCE-RLS gated by
  //     breeze_has_partner_access() → false for an empty partner allowlist) → the role
  //     row is filtered to 0 rows → every tools/call dies "no role assigned".
  //
  // Fix: resolve each axis under a context that can read it, escalating to a fresh
  // system transaction ONLY for the axis the ambient context is blind to. `canSee`
  // mirrors breeze_has_org_access / breeze_has_partner_access exactly, so an allowlist
  // hit ⇒ RLS returns the row (reuse the ambient txn — zero extra connection); a miss
  // (or no ambient context) ⇒ escalate. Because the reads are equality-keyed by the
  // explicit userId + orgId/partnerId args, a system-scope read can only surface that
  // one pinned row or nothing — never another user's/tenant's row — so over-escalation
  // is at worst a perf miss, never a leak. Escalation runs only on a cache MISS, and
  // only for the blind axis: org-members and same-tenant callers keep reusing their
  // request transaction (no extra pooled connection on the hot path — the #1105 class).
  //
  // withDbAccessContext early-returns (no-op) when a context is already active, so
  // withSystemDbAccessContext alone can't widen a narrower ambient context — we must
  // runOutsideDbContext FIRST to exit it, then open a fresh system-scoped transaction.
  const ambient = getCurrentDbAccessContext();
  const canSee = (axis: 'org' | 'partner', id: string): boolean => {
    if (!ambient) return false; // contextless → must escalate
    if (ambient.scope === 'system') return true; // system reads every row
    const ids = axis === 'org' ? ambient.accessibleOrgIds : ambient.accessiblePartnerIds;
    return ids?.includes(id) ?? false;
  };
  const runForAxis = <T>(visible: boolean, fn: () => Promise<T>): Promise<T> =>
    visible ? fn() : runOutsideDbContext(() => withSystemDbAccessContext(fn));

  const buildPerms = async (
    roleId: string,
    scope: 'partner' | 'organization',
    extra: Pick<UserPermissions, 'orgAccess' | 'allowedOrgIds' | 'allowedSiteIds'>,
  ): Promise<UserPermissions> => {
    const rolePerms = await db
      .select({ resource: permissions.resource, action: permissions.action })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, roleId));
    return {
      permissions: rolePerms.map(p => ({ resource: p.resource, action: p.action })),
      partnerId: context.partnerId || null,
      orgId: context.orgId || null,
      roleId,
      scope,
      ...extra,
    };
  };

  // Org-axis first (org membership takes precedence over partner membership).
  const resolveOrgAxis = async (): Promise<UserPermissions | null> => {
    const [orgUser] = await db
      .select()
      .from(organizationUsers)
      .where(and(eq(organizationUsers.userId, userId), eq(organizationUsers.orgId, context.orgId!)))
      .limit(1);
    // No membership row, or one without a usable role, means "nothing on this
    // axis" — fall through to the partner axis (mirrors the original
    // `if (orgUser) roleId = ...; if (!roleId && partnerId) ...` precedence).
    if (!orgUser?.roleId) return null;
    return buildPerms(orgUser.roleId, 'organization', {
      allowedSiteIds: orgUser.siteIds || undefined,
    });
  };

  const resolvePartnerAxis = async (): Promise<UserPermissions | null> => {
    const [partnerUser] = await db
      .select()
      .from(partnerUsers)
      .where(and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, context.partnerId!)))
      .limit(1);
    if (!partnerUser?.roleId) return null;
    return buildPerms(partnerUser.roleId, 'partner', {
      orgAccess: partnerUser.orgAccess,
      allowedOrgIds: partnerUser.orgIds || undefined,
    });
  };

  let userPerms: UserPermissions | null = null;
  if (context.orgId) {
    userPerms = await runForAxis(canSee('org', context.orgId), resolveOrgAxis);
  }
  if (!userPerms && context.partnerId) {
    userPerms = await runForAxis(canSee('partner', context.partnerId), resolvePartnerAxis);
  }

  if (!userPerms) {
    return null;
  }

  // Cache the result
  permissionCache.set(cacheKey, {
    userPerms,
    expiresAt: Date.now() + CACHE_TTL,
    versions,
  });

  return userPerms;
}

export function hasPermission(
  userPerms: UserPermissions,
  resource: string,
  action: string
): boolean {
  return userPerms.permissions.some(
    p => (p.resource === resource || p.resource === '*') &&
         (p.action === action || p.action === '*')
  );
}

// Gates who may decide (approve/deny) a pending action-intent approval
// (§4, 2026-07-18-action-intents-approval-layer-design.md). `userPerms` is
// already resolved per-org/per-partner by getUserPermissions(userId, {orgId})
// — mirrors every other hasPermission(userPerms, resource, action) call site
// (e.g. aiToolsTicketing.ts) — so this helper does not take a separate orgId;
// callers resolve org-scoped perms first, same as the rest of the module.
export function userCanDecideApprovals(userPerms: UserPermissions): boolean {
  return hasPermission(userPerms, PERMISSIONS.APPROVALS_DECIDE.resource, PERMISSIONS.APPROVALS_DECIDE.action);
}

export function canAccessOrg(
  userPerms: UserPermissions,
  orgId: string
): boolean {
  // Organization users can only access their own org
  if (userPerms.scope === 'organization') {
    return userPerms.orgId === orgId;
  }

  // Partner users depend on orgAccess setting
  if (userPerms.scope === 'partner') {
    if (userPerms.orgAccess === 'all') return true;
    if (userPerms.orgAccess === 'none') return false;
    if (userPerms.orgAccess === 'selected') {
      return userPerms.allowedOrgIds?.includes(orgId) || false;
    }
  }

  // System scope has full access
  return true;
}

export function canAccessSite(
  userPerms: UserPermissions,
  siteId: string
): boolean {
  // If no site restrictions, allow access
  if (!userPerms.allowedSiteIds) return true;

  return userPerms.allowedSiteIds.includes(siteId);
}

export async function clearPermissionCache(userId?: string): Promise<void> {
  if (userId) {
    // Clear all entries for this user
    for (const key of permissionCache.keys()) {
      if (key.startsWith(userId + ':')) {
        permissionCache.delete(key);
      }
    }
  } else {
    permissionCache.clear();
  }

  await bumpSharedPermissionCacheVersion(userId);
}

// Built-in system permissions. The registry itself lives in @breeze/shared (as
// PERMISSION_GRANTS) so the web UI can type its gate literals against the same
// closed set; aliased here as PERMISSIONS so existing call sites are unchanged.
export const PERMISSIONS = PERMISSION_GRANTS;

export function permissionKey(permission: Permission): string {
  return `${permission.resource}:${permission.action}`;
}

export const KNOWN_PERMISSIONS = Object.freeze(
  Object.values(PERMISSIONS) as Permission[],
);

export const KNOWN_PERMISSION_KEYS = Object.freeze(
  KNOWN_PERMISSIONS.map(permissionKey),
);

export const ASSIGNABLE_PERMISSIONS = Object.freeze(
  KNOWN_PERMISSIONS.filter((permission) => permission.resource !== '*' && permission.action !== '*'),
);

export const ASSIGNABLE_PERMISSION_KEYS = Object.freeze(
  ASSIGNABLE_PERMISSIONS.map(permissionKey),
);

const KNOWN_PERMISSION_KEY_SET = new Set(KNOWN_PERMISSION_KEYS);
const ASSIGNABLE_PERMISSION_KEY_SET = new Set(ASSIGNABLE_PERMISSION_KEYS);

export function isKnownPermission(permission: Permission): boolean {
  return KNOWN_PERMISSION_KEY_SET.has(permissionKey(permission));
}

export function isAssignablePermission(permission: Permission): boolean {
  return ASSIGNABLE_PERMISSION_KEY_SET.has(permissionKey(permission));
}
