import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  roles: {},
  permissions: {
    id: 'permissions.id',
    resource: 'permissions.resource',
    action: 'permissions.action'
  },
  rolePermissions: {
    roleId: 'rolePermissions.roleId',
    permissionId: 'rolePermissions.permissionId'
  },
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    roleId: 'partnerUsers.roleId',
    orgAccess: 'partnerUsers.orgAccess',
    orgIds: 'partnerUsers.orgIds'
  },
  organizationUsers: {
    userId: 'organizationUsers.userId',
    orgId: 'organizationUsers.orgId',
    roleId: 'organizationUsers.roleId',
    siteIds: 'organizationUsers.siteIds'
  }
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => null)
}));

import {
  getUserPermissions,
  hasPermission,
  canAccessOrg,
  canAccessSite,
  clearPermissionCache,
  isAssignablePermission,
  isKnownPermission,
  PERMISSIONS,
  type UserPermissions
} from './permissions';
import { db } from '../db';
import { getRedis } from './redis';

describe('permissions service', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue(null);
    await clearPermissionCache();
  });

  describe('hasPermission', () => {
    it('should return true for exact permission match', () => {
      const userPerms: UserPermissions = {
        permissions: [{ resource: 'devices', action: 'read' }],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(hasPermission(userPerms, 'devices', 'read')).toBe(true);
    });

    it('should return false when permission not found', () => {
      const userPerms: UserPermissions = {
        permissions: [{ resource: 'devices', action: 'read' }],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(hasPermission(userPerms, 'devices', 'write')).toBe(false);
      expect(hasPermission(userPerms, 'scripts', 'read')).toBe(false);
    });

    it('should match wildcard resource (*)', () => {
      const userPerms: UserPermissions = {
        permissions: [{ resource: '*', action: 'read' }],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(hasPermission(userPerms, 'devices', 'read')).toBe(true);
      expect(hasPermission(userPerms, 'scripts', 'read')).toBe(true);
      expect(hasPermission(userPerms, 'anything', 'read')).toBe(true);
      expect(hasPermission(userPerms, 'devices', 'write')).toBe(false);
    });

    it('should match wildcard action (*)', () => {
      const userPerms: UserPermissions = {
        permissions: [{ resource: 'devices', action: '*' }],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(hasPermission(userPerms, 'devices', 'read')).toBe(true);
      expect(hasPermission(userPerms, 'devices', 'write')).toBe(true);
      expect(hasPermission(userPerms, 'devices', 'delete')).toBe(true);
      expect(hasPermission(userPerms, 'scripts', 'read')).toBe(false);
    });

    it('should match full wildcard (*:*)', () => {
      const userPerms: UserPermissions = {
        permissions: [{ resource: '*', action: '*' }],
        partnerId: null,
        orgId: null,
        roleId: 'role-1',
        scope: 'system'
      };

      expect(hasPermission(userPerms, 'devices', 'read')).toBe(true);
      expect(hasPermission(userPerms, 'scripts', 'execute')).toBe(true);
      expect(hasPermission(userPerms, 'anything', 'anything')).toBe(true);
    });

    it('should check multiple permissions', () => {
      const userPerms: UserPermissions = {
        permissions: [
          { resource: 'devices', action: 'read' },
          { resource: 'devices', action: 'write' },
          { resource: 'scripts', action: 'read' }
        ],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(hasPermission(userPerms, 'devices', 'read')).toBe(true);
      expect(hasPermission(userPerms, 'devices', 'write')).toBe(true);
      expect(hasPermission(userPerms, 'scripts', 'read')).toBe(true);
      expect(hasPermission(userPerms, 'scripts', 'write')).toBe(false);
      expect(hasPermission(userPerms, 'devices', 'delete')).toBe(false);
    });

    it('should return false for empty permissions', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(hasPermission(userPerms, 'devices', 'read')).toBe(false);
    });
  });

  describe('canAccessOrg', () => {
    it('should allow organization user to access their own org', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(canAccessOrg(userPerms, 'org-1')).toBe(true);
    });

    it('should deny organization user access to other orgs', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
      };

      expect(canAccessOrg(userPerms, 'org-2')).toBe(false);
      expect(canAccessOrg(userPerms, 'other-org')).toBe(false);
    });

    it('should allow partner user with "all" orgAccess to any org', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: 'partner-1',
        orgId: null,
        roleId: 'role-1',
        scope: 'partner',
        orgAccess: 'all'
      };

      expect(canAccessOrg(userPerms, 'org-1')).toBe(true);
      expect(canAccessOrg(userPerms, 'org-2')).toBe(true);
      expect(canAccessOrg(userPerms, 'any-org')).toBe(true);
    });

    it('should deny partner user with "none" orgAccess', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: 'partner-1',
        orgId: null,
        roleId: 'role-1',
        scope: 'partner',
        orgAccess: 'none'
      };

      expect(canAccessOrg(userPerms, 'org-1')).toBe(false);
      expect(canAccessOrg(userPerms, 'org-2')).toBe(false);
    });

    it('should allow partner user with "selected" orgAccess to allowed orgs only', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: 'partner-1',
        orgId: null,
        roleId: 'role-1',
        scope: 'partner',
        orgAccess: 'selected',
        allowedOrgIds: ['org-1', 'org-3']
      };

      expect(canAccessOrg(userPerms, 'org-1')).toBe(true);
      expect(canAccessOrg(userPerms, 'org-3')).toBe(true);
      expect(canAccessOrg(userPerms, 'org-2')).toBe(false);
      expect(canAccessOrg(userPerms, 'org-4')).toBe(false);
    });

    it('should deny partner user with "selected" but empty allowedOrgIds', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: 'partner-1',
        orgId: null,
        roleId: 'role-1',
        scope: 'partner',
        orgAccess: 'selected',
        allowedOrgIds: []
      };

      expect(canAccessOrg(userPerms, 'org-1')).toBe(false);
    });

    it('should deny partner user with "selected" but undefined allowedOrgIds', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: 'partner-1',
        orgId: null,
        roleId: 'role-1',
        scope: 'partner',
        orgAccess: 'selected'
        // allowedOrgIds is undefined
      };

      expect(canAccessOrg(userPerms, 'org-1')).toBe(false);
    });

    it('should allow system scope access to all orgs', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: null,
        roleId: 'role-1',
        scope: 'system'
      };

      expect(canAccessOrg(userPerms, 'org-1')).toBe(true);
      expect(canAccessOrg(userPerms, 'org-2')).toBe(true);
      expect(canAccessOrg(userPerms, 'any-org')).toBe(true);
    });
  });

  describe('canAccessSite', () => {
    it('should allow access when no site restrictions', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization'
        // allowedSiteIds is undefined
      };

      expect(canAccessSite(userPerms, 'site-1')).toBe(true);
      expect(canAccessSite(userPerms, 'any-site')).toBe(true);
    });

    it('should allow access to allowed sites', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization',
        allowedSiteIds: ['site-1', 'site-2']
      };

      expect(canAccessSite(userPerms, 'site-1')).toBe(true);
      expect(canAccessSite(userPerms, 'site-2')).toBe(true);
    });

    it('should deny access to non-allowed sites', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization',
        allowedSiteIds: ['site-1', 'site-2']
      };

      expect(canAccessSite(userPerms, 'site-3')).toBe(false);
      expect(canAccessSite(userPerms, 'other-site')).toBe(false);
    });

    it('should deny access when allowedSiteIds is empty', () => {
      const userPerms: UserPermissions = {
        permissions: [],
        partnerId: null,
        orgId: 'org-1',
        roleId: 'role-1',
        scope: 'organization',
        allowedSiteIds: []
      };

      expect(canAccessSite(userPerms, 'site-1')).toBe(false);
    });
  });

  describe('clearPermissionCache', () => {
    it('should not throw when clearing cache', async () => {
      await expect(clearPermissionCache()).resolves.toBeUndefined();
    });

    it('should not throw when clearing cache for specific user', async () => {
      await expect(clearPermissionCache('user-123')).resolves.toBeUndefined();
    });

    it('bumps shared Redis user versions so stale entries are rejected across API instances', async () => {
      const redis = {
        mget: vi.fn()
          .mockResolvedValueOnce(['0', '0'])
          .mockResolvedValueOnce(['0', '0'])
          .mockResolvedValueOnce(['0', '1']),
        incr: vi.fn().mockResolvedValue(1)
      };
      vi.mocked(getRedis).mockReturnValue(redis as any);

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ roleId: 'role-reader', siteIds: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ resource: 'devices', action: 'read' }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ roleId: 'role-writer', siteIds: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ resource: 'devices', action: 'write' }])
            })
          })
        } as any);

      const first = await getUserPermissions('user-123', { orgId: 'org-123' });
      const second = await getUserPermissions('user-123', { orgId: 'org-123' });

      expect(first?.permissions).toEqual([{ resource: 'devices', action: 'read' }]);
      expect(second?.permissions).toEqual([{ resource: 'devices', action: 'read' }]);
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);

      const third = await getUserPermissions('user-123', { orgId: 'org-123' });

      expect(third?.permissions).toEqual([{ resource: 'devices', action: 'write' }]);
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);

      await clearPermissionCache('user-123');
      expect(redis.incr).toHaveBeenCalledWith('permission-cache:user-version:user-123');
    });
  });

  describe('PERMISSIONS constant', () => {
    it('should have device permissions defined', () => {
      expect(PERMISSIONS.DEVICES_READ).toEqual({ resource: 'devices', action: 'read' });
      expect(PERMISSIONS.DEVICES_WRITE).toEqual({ resource: 'devices', action: 'write' });
      expect(PERMISSIONS.DEVICES_DELETE).toEqual({ resource: 'devices', action: 'delete' });
      expect(PERMISSIONS.DEVICES_EXECUTE).toEqual({ resource: 'devices', action: 'execute' });
    });

    it('should have admin all permission', () => {
      expect(PERMISSIONS.ADMIN_ALL).toEqual({ resource: '*', action: '*' });
    });

    it('should have user permissions defined', () => {
      expect(PERMISSIONS.USERS_READ).toEqual({ resource: 'users', action: 'read' });
      expect(PERMISSIONS.USERS_WRITE).toEqual({ resource: 'users', action: 'write' });
      expect(PERMISSIONS.USERS_DELETE).toEqual({ resource: 'users', action: 'delete' });
      expect(PERMISSIONS.USERS_INVITE).toEqual({ resource: 'users', action: 'invite' });
    });

    it('exposes a known-permission allowlist that excludes wildcard from custom assignment', () => {
      expect(isKnownPermission(PERMISSIONS.ADMIN_ALL)).toBe(true);
      expect(isAssignablePermission(PERMISSIONS.ADMIN_ALL)).toBe(false);
      expect(isAssignablePermission(PERMISSIONS.DEVICES_READ)).toBe(true);
      expect(isKnownPermission({ resource: 'not-real', action: 'write' })).toBe(false);
    });
  });
});
