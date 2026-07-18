import { describe, it, expect, beforeEach, vi } from 'vitest';

// getUserPermissions resolves a user's role per-axis on a cache miss, escalating to a
// fresh SYSTEM RLS context only for the axis the ambient context can't see: it
// runOutsideDbContext (to exit the narrower ambient context, e.g. the org-scoped
// MCP/API-key context from #2019) then withSystemDbAccessContext. When the ambient
// context (getCurrentDbAccessContext) already grants visibility it reuses it — no
// escalation. Both wrappers are transparent pass-throughs here so the wrapped reads
// still run against the mocked db; the spies + the mocked ambient context let tests
// assert when escalation happens vs. when the request transaction is reused.
const mockWithSystemDbAccessContext = vi.fn(<T>(fn: () => Promise<T>) => fn());
const mockRunOutsideDbContext = vi.fn(<T>(fn: () => T) => fn());
const mockGetCurrentDbAccessContext = vi.fn<() => unknown>(() => undefined);
vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => mockWithSystemDbAccessContext(fn),
  runOutsideDbContext: <T>(fn: () => T) => mockRunOutsideDbContext(fn),
  getCurrentDbAccessContext: () => mockGetCurrentDbAccessContext()
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
  userCanDecideApprovals,
  PERMISSIONS,
  type UserPermissions
} from './permissions';
import { db } from '../db';
import { getRedis } from './redis';

describe('permissions service', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue(null);
    mockWithSystemDbAccessContext.mockImplementation(<T>(fn: () => Promise<T>) => fn());
    mockRunOutsideDbContext.mockImplementation(<T>(fn: () => T) => fn());
    mockGetCurrentDbAccessContext.mockReturnValue(undefined); // contextless by default
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

  describe('getUserPermissions DB access context (#1448)', () => {
    function mockMembershipAndRoleReads() {
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
        } as any);
    }

    it('escalates RLS reads to a fresh system context, runOutsideDbContext BEFORE withSystemDbAccessContext (#1448 contextless + #2019 narrower-ctx)', async () => {
      // On a cache miss the membership reads must resolve under SYSTEM scope so they
      // aren't RLS-filtered to 0 rows → null → 403 / "no role assigned". This covers
      // both failure classes the wrap exists for: NO ambient context (#1448 pay-route)
      // and a NARROWER ambient context (#2019 org-scoped MCP key, accessiblePartnerIds=[]).
      // The mock layer can't distinguish the two (production no longer reads
      // hasDbAccessContext) — the real per-scenario RLS proof lives in
      // permissionsContext.integration.test.ts. What this unit test pins that the
      // integration test can't run cheaply is the ORDER: withDbAccessContext is a no-op
      // while a context is active, so runOutsideDbContext MUST run first. A swapped
      // wrap (withSystemDbAccessContext(() => runOutsideDbContext(fn))) would keep the
      // call COUNTS identical but silently reintroduce #2019 — the order assertion is
      // the only unit-level guard against that regression.
      mockMembershipAndRoleReads();

      const perms = await getUserPermissions('user-123', { orgId: 'org-123' });

      expect(perms).not.toBeNull();
      expect(perms?.permissions).toEqual([{ resource: 'devices', action: 'read' }]);
      expect(mockRunOutsideDbContext).toHaveBeenCalledTimes(1);
      expect(mockWithSystemDbAccessContext).toHaveBeenCalledTimes(1);
      // runOutsideDbContext must be entered before withSystemDbAccessContext.
      expect(mockRunOutsideDbContext.mock.invocationCallOrder[0]!)
        .toBeLessThan(mockWithSystemDbAccessContext.mock.invocationCallOrder[0]!);
    });

    it('does NOT open the system-context wrapper on a warm cache hit (conn-hold guard, #1105 class)', async () => {
      // The wrap runs only on a cache MISS — the comment in permissions.ts promises the
      // extra context churn stays off the warm path. A regression that re-escalates on
      // every hit would, under a cluster-wide cache bump, hold 2 pooled connections per
      // request and risk pool starvation (the documented #1105 conn-hold class). Pin it:
      // a second call for the same key must be served from cache with zero wrap calls.
      mockMembershipAndRoleReads();

      await getUserPermissions('user-123', { orgId: 'org-123' }); // miss → escalates once
      const before = mockRunOutsideDbContext.mock.calls.length;
      const cached = await getUserPermissions('user-123', { orgId: 'org-123' }); // hit

      expect(cached?.permissions).toEqual([{ resource: 'devices', action: 'read' }]);
      expect(mockRunOutsideDbContext.mock.calls.length).toBe(before); // no new escalation
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2); // both reads only on the miss
    });

    it('propagates (does NOT swallow into null) when the system-context read throws', async () => {
      // The whole point of the fix is that RLS-filtered-0-rows must not look like a DB
      // error AND a real DB error (pool exhausted, txn timeout) must not look like
      // "no role". A future careless `try { ... } catch { return null }` around the wrap
      // would silently turn infra faults into 403s — assert the throw reaches the caller.
      mockRunOutsideDbContext.mockImplementationOnce(() => {
        throw new Error('pool exhausted');
      });

      await expect(getUserPermissions('user-123', { orgId: 'org-123' }))
        .rejects.toThrow('pool exhausted');
    });

    it('REUSES the ambient transaction (no escalation) when it already grants the axis visibility', async () => {
      // The common dashboard path: an org user inside their own org-scope context. The
      // ambient context's accessibleOrgIds already covers the org, so canSee('org') is
      // true and the org-membership read must run in-place — NO runOutsideDbContext, NO
      // extra pooled connection. This is the conn-hold mitigation (#1105) made concrete.
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'organization',
        accessibleOrgIds: ['org-123'],
        accessiblePartnerIds: [],
      });
      mockMembershipAndRoleReads();

      const perms = await getUserPermissions('user-123', { orgId: 'org-123' });

      expect(perms?.permissions).toEqual([{ resource: 'devices', action: 'read' }]);
      expect(mockRunOutsideDbContext).not.toHaveBeenCalled();
      expect(mockWithSystemDbAccessContext).not.toHaveBeenCalled();
    });

    it('escalates ONLY the blind partner-axis fallback, reusing the ambient txn for the org read (#2019 MCP org-key)', async () => {
      // The exact #2019 shape at unit level: org-scope context (sees its org) with an
      // empty partner allowlist. A membership-less Partner Admin has NO org_users row,
      // so the org read is reused-but-empty, then the partner fallback — which the
      // ambient context is blind to — must escalate. Proves escalation is scoped to the
      // blind axis, not applied wholesale.
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'organization',
        accessibleOrgIds: ['org-123'],
        accessiblePartnerIds: [], // blind to the partner axis
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({ // org_users read → empty (no org membership)
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
          })
        } as any)
        .mockReturnValueOnce({ // partner_users read → the partner role
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ roleId: 'role-partner', orgAccess: 'all', orgIds: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({ // role_permissions read
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ resource: 'devices', action: 'read' }])
            })
          })
        } as any);

      const perms = await getUserPermissions('user-123', { orgId: 'org-123', partnerId: 'partner-1' });

      expect(perms?.scope).toBe('partner');
      expect(perms?.permissions).toEqual([{ resource: 'devices', action: 'read' }]);
      // Exactly one escalation — for the partner fallback only; the org read was reused.
      expect(mockRunOutsideDbContext).toHaveBeenCalledTimes(1);
      expect(mockWithSystemDbAccessContext).toHaveBeenCalledTimes(1);
    });

    it('returns null (→ 403) when the user has no membership, regardless of context', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const perms = await getUserPermissions('user-orphan', { orgId: 'org-123' });

      expect(perms).toBeNull();
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

  describe('sso:admin permission (security review #2 H-2)', () => {
    it('is defined in the catalog as resource=sso action=admin', () => {
      expect(PERMISSIONS.SSO_ADMIN).toEqual({ resource: 'sso', action: 'admin' });
    });

    it('is a known, assignable permission', () => {
      const p = { resource: 'sso', action: 'admin' };
      expect(isKnownPermission(p)).toBe(true);
      expect(isAssignablePermission(p)).toBe(true);
    });
  });

  describe('approvals:decide permission (action intents approval layer, §4)', () => {
    it('is defined in the catalog as resource=approvals action=decide', () => {
      expect(PERMISSIONS.APPROVALS_DECIDE).toEqual({ resource: 'approvals', action: 'decide' });
    });

    it('is a known, assignable permission', () => {
      const p = { resource: 'approvals', action: 'decide' };
      expect(isKnownPermission(p)).toBe(true);
      expect(isAssignablePermission(p)).toBe(true);
    });

    describe('userCanDecideApprovals', () => {
      it('returns true for an Org Admin-shaped grant (explicit approvals:decide)', () => {
        const userPerms: UserPermissions = {
          permissions: [{ resource: 'approvals', action: 'decide' }],
          partnerId: null,
          orgId: 'org-1',
          roleId: 'role-org-admin',
          scope: 'organization'
        };

        expect(userCanDecideApprovals(userPerms)).toBe(true);
      });

      it('returns true for a Partner Admin-shaped grant via the *:* wildcard', () => {
        const userPerms: UserPermissions = {
          permissions: [{ resource: '*', action: '*' }],
          partnerId: 'partner-1',
          orgId: null,
          roleId: 'role-partner-admin',
          scope: 'partner'
        };

        expect(userCanDecideApprovals(userPerms)).toBe(true);
      });

      it('returns false for an Org Technician-shaped grant (no approvals:decide)', () => {
        const userPerms: UserPermissions = {
          permissions: [
            { resource: 'devices', action: 'read' },
            { resource: 'devices', action: 'write' },
            { resource: 'devices', action: 'execute' },
            { resource: 'scripts', action: 'read' },
            { resource: 'scripts', action: 'execute' }
          ],
          partnerId: null,
          orgId: 'org-1',
          roleId: 'role-org-technician',
          scope: 'organization'
        };

        expect(userCanDecideApprovals(userPerms)).toBe(false);
      });

      it('returns false for empty permissions', () => {
        const userPerms: UserPermissions = {
          permissions: [],
          partnerId: null,
          orgId: 'org-1',
          roleId: 'role-1',
          scope: 'organization'
        };

        expect(userCanDecideApprovals(userPerms)).toBe(false);
      });
    });
  });
});
