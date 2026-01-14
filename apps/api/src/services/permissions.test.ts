import { describe, it, expect, beforeEach } from 'vitest';
import {
  hasPermission,
  canAccessOrg,
  canAccessSite,
  clearPermissionCache,
  PERMISSIONS,
  type UserPermissions
} from './permissions';

describe('permissions service', () => {
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
    it('should not throw when clearing cache', () => {
      expect(() => clearPermissionCache()).not.toThrow();
    });

    it('should not throw when clearing cache for specific user', () => {
      expect(() => clearPermissionCache('user-123')).not.toThrow();
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
  });
});
