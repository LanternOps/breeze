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
  users: {
    id: 'users.id',
    isPlatformAdmin: 'users.isPlatformAdmin'
  },
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

  // #5733 — a LOGIN-produced scope='system' access token is minted ONLY for a
  // membership-less platform admin (routes/auth/helpers.ts
  // resolveCurrentUserTokenContext) — scope 'system' with NEITHER partnerId NOR
  // orgId — so the membership-only resolver below it returned null →
  // requirePermission answered 403 "No permissions found" on EVERY
  // requirePermission route. The system branch grants the wildcard set, but only
  // for that null/null shape and only against a LIVE users.is_platform_admin read
  // — never the token's own scope claim on its own. A system token that carries an
  // axis keeps the #5071 contract: the membership's grants still govern.
  describe('getUserPermissions system scope (#5733)', () => {
    function mockPlatformAdminRead(rows: Array<{ isPlatformAdmin: boolean }>) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows)
          })
        })
      } as any);
    }

    it('grants the wildcard set to a LIVE platform admin and never touches the membership tables', async () => {
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'system',
        accessibleOrgIds: null,
        accessiblePartnerIds: [],
      });
      mockPlatformAdminRead([{ isPlatformAdmin: true }]);

      const perms = await getUserPermissions('admin-1', { scope: 'system' });

      expect(perms).not.toBeNull();
      expect(perms!.scope).toBe('system');
      expect(perms!.partnerId).toBeNull();
      expect(perms!.orgId).toBeNull();
      expect(perms!.permissions).toEqual([{ resource: '*', action: '*' }]);
      expect(hasPermission(perms!, 'organizations', 'read')).toBe(true);
      // ONE read — the users row. No partner_users / organization_users lookup:
      // a system token has neither axis to look up.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });

    it('returns null (→ 403) for a system token whose user is NOT a platform admin', async () => {
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'system',
        accessibleOrgIds: null,
        accessiblePartnerIds: [],
      });
      mockPlatformAdminRead([{ isPlatformAdmin: false }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(await getUserPermissions('not-admin', { scope: 'system' })).toBeNull();
      // Leaves the same diagnostic trail as authMiddleware's SR2-02 rejection:
      // reaching this branch at all means the demotion landed mid-request.
      expect(warn).toHaveBeenCalledWith('[permissions] denied system-scope token', {
        reason: 'system_scope_not_platform_admin',
        userId: 'not-admin',
      });
      warn.mockRestore();
    });

    it('returns null when the user row is gone entirely', async () => {
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'system',
        accessibleOrgIds: null,
        accessiblePartnerIds: [],
      });
      mockPlatformAdminRead([]);

      expect(await getUserPermissions('deleted-user', { scope: 'system' })).toBeNull();
    });

    it('re-reads is_platform_admin on EVERY call — the grant is never cached', async () => {
      // A demotion (is_platform_admin → false) must take effect on the next request,
      // not after the 5-minute permission-cache TTL. authMiddleware's SR2-02 check
      // already re-reads the live row; caching the grant here would reopen the hole
      // for any caller that reaches getUserPermissions without that middleware.
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'system',
        accessibleOrgIds: null,
        accessiblePartnerIds: [],
      });
      mockPlatformAdminRead([{ isPlatformAdmin: true }]);
      expect(await getUserPermissions('admin-1', { scope: 'system' })).not.toBeNull();

      mockPlatformAdminRead([{ isPlatformAdmin: false }]);
      expect(await getUserPermissions('admin-1', { scope: 'system' })).toBeNull();
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    });

    it('escalates the users read out of a narrower ambient context, runOutsideDbContext FIRST', async () => {
      // users is FORCE-RLS and dual-axis; a context that cannot see the row would
      // filter it to 0 rows and fail a live platform admin closed. Identity, not
      // tenant data — same rationale (and same ordering trap) as the membership reads.
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'organization',
        accessibleOrgIds: ['org-123'],
        accessiblePartnerIds: [],
      });
      mockPlatformAdminRead([{ isPlatformAdmin: true }]);

      const perms = await getUserPermissions('admin-1', { scope: 'system' });

      expect(perms!.permissions).toEqual([{ resource: '*', action: '*' }]);
      expect(mockRunOutsideDbContext).toHaveBeenCalledTimes(1);
      expect(mockWithSystemDbAccessContext).toHaveBeenCalledTimes(1);
      expect(mockRunOutsideDbContext.mock.invocationCallOrder[0]!)
        .toBeLessThan(mockWithSystemDbAccessContext.mock.invocationCallOrder[0]!);
    });

    it('leaves the ordinary membership path untouched when scope is not system', async () => {
      // The branch is keyed on the token scope, not on is_platform_admin: a platform
      // admin holding a PARTNER token still resolves their partner role, so their
      // own partner membership keeps bounding what they can do.
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'partner',
        accessibleOrgIds: ['org-123'],
        accessiblePartnerIds: ['partner-1'],
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ roleId: 'role-partner', orgAccess: 'all', orgIds: null }])
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

      const perms = await getUserPermissions('admin-1', { partnerId: 'partner-1', scope: 'partner' });

      expect(perms!.scope).toBe('partner');
      expect(perms!.permissions).toEqual([{ resource: 'devices', action: 'read' }]);
    });

    // The three shapes the bypass is pinned to. (a) is the login shape the fix
    // exists for; (b) is the #5071 contract the bypass must NOT widen past
    // (RMM-QA-221 in siteAggregateScope.integration.test.ts asserts the 403 end
    // to end); (c) is the demoted/never-admin denial.
    it('(b) a system token carrying a partnerId resolves from the membership, NOT the wildcard', async () => {
      // #5071: when a system-scope token carries a membership, the membership's
      // grants still govern. A platform admin whose partner role grants nothing
      // must still be denied — otherwise the bypass silently escalates every
      // system-scope token that happens to have a partnerId claim.
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'system',
        accessibleOrgIds: null,
        accessiblePartnerIds: ['partner-1'],
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ roleId: 'role-no-read', orgAccess: 'all', orgIds: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const perms = await getUserPermissions('admin-1', { partnerId: 'partner-1', scope: 'system' });

      expect(perms).not.toBeNull();
      expect(perms!.scope).toBe('partner');
      expect(perms!.roleId).toBe('role-no-read');
      expect(perms!.permissions).toEqual([]);
      expect(hasPermission(perms!, 'devices', 'read')).toBe(false);
      // Membership reads, not the users.is_platform_admin read: the wildcard
      // branch was never entered.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    });

    it('(b) a system token carrying an orgId resolves from the org membership, NOT the wildcard', async () => {
      mockGetCurrentDbAccessContext.mockReturnValue({
        scope: 'system',
        accessibleOrgIds: ['org-123'],
        accessiblePartnerIds: [],
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ roleId: 'role-no-read', siteIds: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const perms = await getUserPermissions('admin-1', { orgId: 'org-123', scope: 'system' });

      expect(perms!.scope).toBe('organization');
      expect(perms!.permissions).toEqual([]);
      expect(hasPermission(perms!, 'devices', 'read')).toBe(false);
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
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
