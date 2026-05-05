import { db } from '../db';
import { roles, permissions, rolePermissions, partnerUsers, organizationUsers } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getRedis } from './redis';

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

  let roleId: string | null = null;
  let scope: 'system' | 'partner' | 'organization' = 'system';
  let orgAccess: 'all' | 'selected' | 'none' | undefined;
  let allowedOrgIds: string[] | undefined;
  let allowedSiteIds: string[] | undefined;

  // Check organization-level access first
  if (context.orgId) {
    const [orgUser] = await db
      .select()
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.userId, userId),
          eq(organizationUsers.orgId, context.orgId)
        )
      )
      .limit(1);

    if (orgUser) {
      roleId = orgUser.roleId;
      scope = 'organization';
      allowedSiteIds = orgUser.siteIds || undefined;
    }
  }

  // Check partner-level access
  if (!roleId && context.partnerId) {
    const [partnerUser] = await db
      .select()
      .from(partnerUsers)
      .where(
        and(
          eq(partnerUsers.userId, userId),
          eq(partnerUsers.partnerId, context.partnerId)
        )
      )
      .limit(1);

    if (partnerUser) {
      roleId = partnerUser.roleId;
      scope = 'partner';
      orgAccess = partnerUser.orgAccess;
      allowedOrgIds = partnerUser.orgIds || undefined;
    }
  }

  if (!roleId) {
    return null;
  }

  // Get role permissions
  const rolePerms = await db
    .select({
      resource: permissions.resource,
      action: permissions.action
    })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  const perms = rolePerms.map(p => ({ resource: p.resource, action: p.action }));

  const userPerms = {
    permissions: perms,
    partnerId: context.partnerId || null,
    orgId: context.orgId || null,
    roleId,
    scope,
    orgAccess,
    allowedOrgIds,
    allowedSiteIds
  };

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

// Built-in system permissions
export const PERMISSIONS = {
  // Backup / recovery
  BACKUP_READ: { resource: 'backup', action: 'read' },
  BACKUP_WRITE: { resource: 'backup', action: 'write' },

  // Devices
  DEVICES_READ: { resource: 'devices', action: 'read' },
  DEVICES_WRITE: { resource: 'devices', action: 'write' },
  DEVICES_DELETE: { resource: 'devices', action: 'delete' },
  DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },

  // Scripts
  SCRIPTS_READ: { resource: 'scripts', action: 'read' },
  SCRIPTS_WRITE: { resource: 'scripts', action: 'write' },
  SCRIPTS_DELETE: { resource: 'scripts', action: 'delete' },
  SCRIPTS_EXECUTE: { resource: 'scripts', action: 'execute' },

  // Alerts
  ALERTS_READ: { resource: 'alerts', action: 'read' },
  ALERTS_WRITE: { resource: 'alerts', action: 'write' },
  ALERTS_ACKNOWLEDGE: { resource: 'alerts', action: 'acknowledge' },

  // Users
  USERS_READ: { resource: 'users', action: 'read' },
  USERS_WRITE: { resource: 'users', action: 'write' },
  USERS_DELETE: { resource: 'users', action: 'delete' },
  USERS_INVITE: { resource: 'users', action: 'invite' },

  // Organizations
  ORGS_READ: { resource: 'organizations', action: 'read' },
  ORGS_WRITE: { resource: 'organizations', action: 'write' },
  ORGS_DELETE: { resource: 'organizations', action: 'delete' },

  // Sites
  SITES_READ: { resource: 'sites', action: 'read' },
  SITES_WRITE: { resource: 'sites', action: 'write' },
  SITES_DELETE: { resource: 'sites', action: 'delete' },

  // Automations
  AUTOMATIONS_READ: { resource: 'automations', action: 'read' },
  AUTOMATIONS_WRITE: { resource: 'automations', action: 'write' },
  AUTOMATIONS_DELETE: { resource: 'automations', action: 'delete' },

  // Remote access
  REMOTE_ACCESS: { resource: 'remote', action: 'access' },

  // Audit
  AUDIT_READ: { resource: 'audit', action: 'read' },
  AUDIT_EXPORT: { resource: 'audit', action: 'export' },

  // Reports
  REPORTS_READ: { resource: 'reports', action: 'read' },
  REPORTS_WRITE: { resource: 'reports', action: 'write' },
  REPORTS_DELETE: { resource: 'reports', action: 'delete' },
  REPORTS_EXPORT: { resource: 'reports', action: 'export' },

  // Billing
  BILLING_MANAGE: { resource: 'billing', action: 'manage' },

  // Admin
  ADMIN_ALL: { resource: '*', action: '*' }
} as const;

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
