import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resolveLiveSessionToolAuthority } from './aiSessionLiveAuthority';
import { canAccessOrg, getUserPermissions } from './permissions';
import { checkToolPermissionForResolvedUser } from './aiGuardrails';
import { computeAccessibleOrgIds } from '../middleware/auth';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withSystemDbAccessContext: vi.fn((fn) => fn()),
  db: { select: vi.fn() },
}));
// The real schema and the real drizzle operators are used on purpose: the
// organization guard is asserted by RENDERING the built condition to SQL
// below. Against stubbed columns and a mocked `eq`, `where()` receives an
// opaque placeholder and every such assertion would be vacuous.
vi.mock('./permissions', () => ({ getUserPermissions: vi.fn(), canAccessOrg: vi.fn() }));
vi.mock('./aiGuardrails', () => ({ checkToolPermissionForResolvedUser: vi.fn() }));
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  computeAccessibleOrgIds: vi.fn(),
}));

const { db } = await import('../db');

/** Rows the mocked `db.select()` chain returns, per test. */
let userRows: Record<string, unknown>[] = [];
let orgRows: Record<string, unknown>[] = [];
/** The condition each query passed to `.where()`, captured for SQL assertions. */
const capturedWhere: { user?: unknown; org?: unknown } = {};

function renderSql(condition: unknown) {
  return new PgDialect().sqlToQuery(condition as never);
}

function session(overrides: Record<string, unknown> = {}) {
  const auth = {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'u@example.test', name: 'User', isPlatformAdmin: false },
    token: { roleId: 'role-old' },
    scope: 'organization', orgId: 'org-1', partnerId: 'partner-1',
    accessibleOrgIds: ['org-1'], orgCondition: vi.fn(), canAccessOrg: vi.fn(() => true),
    allowedSiteIds: ['site-old'], canAccessSite: vi.fn(() => true),
  };
  return { auth, toolAuth: auth, orgId: 'org-1', deviceId: null, ...overrides } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  userRows = [{ status: 'active', isPlatformAdmin: false }];
  orgRows = [{ id: 'org-1', partnerId: 'partner-current' }];
  delete capturedWhere.user;
  delete capturedWhere.org;
  // Both queries terminate at `.limit()`. The chain deliberately exposes no
  // `.for()`, so re-introducing a row lock on either read fails loudly here
  // instead of silently reinstating the useless FOR SHARE this dropped.
  vi.mocked(db.select).mockImplementation((columns?: Record<string, unknown>) => {
    const isUserProjection = Boolean(columns && 'isPlatformAdmin' in columns);
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn((condition: unknown) => {
        if (isUserProjection) capturedWhere.user = condition;
        else capturedWhere.org = condition;
        return chain;
      }),
      limit: vi.fn(async () => (isUserProjection ? userRows : orgRows)),
    };
    return chain;
  });
  vi.mocked(getUserPermissions).mockResolvedValue({
    permissions: [], partnerId: 'partner-current', orgId: 'org-1', roleId: 'role-new',
    scope: 'organization', allowedSiteIds: ['site-new'],
  });
  vi.mocked(computeAccessibleOrgIds).mockResolvedValue({ orgIds: ['org-1', 'org-2'], partnerOrgAccess: 'all' });
  vi.mocked(canAccessOrg).mockReturnValue(true);
  vi.mocked(checkToolPermissionForResolvedUser).mockReturnValue(null);
});

describe('resolveLiveSessionToolAuthority', () => {
  it('bypasses the permission cache and replaces stale role/site closures', async () => {
    const result = await resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' });
    expect(result.ok).toBe(true);
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', expect.objectContaining({ bypassCache: true }));
    if (result.ok) {
      expect(result.auth.token?.roleId).toBe('role-new');
      expect(result.auth.scope).toBe('organization');
      expect(result.auth.partnerId).toBeNull();
      expect(result.auth.orgId).toBe('org-1');
      expect(result.auth.user.isPlatformAdmin).toBe(false);
      expect(result.toolAuth.allowedSiteIds).toEqual(['site-new']);
      expect(result.toolAuth.canAccessSite?.('site-old')).toBe(false);
      expect(result.toolAuth.canAccessSite?.('site-new')).toBe(true);
    }
  });

  it('fails closed before release when the exact tool permission was removed', async () => {
    vi.mocked(checkToolPermissionForResolvedUser).mockReturnValue('Insufficient permissions');
    await expect(resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' }))
      .resolves.toEqual({ ok: false, reason: 'Insufficient permissions' });
  });

  it('fails closed when live organization access was removed', async () => {
    vi.mocked(canAccessOrg).mockReturnValue(false);
    const result = await resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' });
    expect(result).toEqual({ ok: false, reason: 'Organization authority was removed' });
    expect(checkToolPermissionForResolvedUser).not.toHaveBeenCalled();
  });

  it.each(['all', 'selected'] as const)('rebuilds partner %s reach from the current organization owner', async (orgAccess) => {
    vi.mocked(getUserPermissions).mockResolvedValue({
      permissions: [], partnerId: 'partner-current', orgId: 'org-1', roleId: 'role-new',
      scope: 'partner', orgAccess,
      ...(orgAccess === 'selected' ? { allowedOrgIds: ['org-1'] } : {}),
    });
    vi.mocked(computeAccessibleOrgIds).mockResolvedValue({
      orgIds: ['org-1', 'org-current-sibling'], partnerOrgAccess: orgAccess,
    });

    const result = await resolveLiveSessionToolAuthority(
      session({ auth: { ...session().auth, scope: 'partner', partnerId: 'partner-stale', orgId: null } }),
      'manage_alerts', { action: 'resolve' },
    );

    expect(result.ok).toBe(true);
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', expect.objectContaining({ partnerId: 'partner-current' }));
    expect(computeAccessibleOrgIds).toHaveBeenCalledWith('partner', 'partner-current', null, 'user-1');
    if (result.ok) {
      expect(result.auth.scope).toBe('partner');
      expect(result.auth.partnerId).toBe('partner-current');
      expect(result.auth.orgId).toBeNull();
      expect(result.auth.accessibleOrgIds).toEqual(['org-1', 'org-current-sibling']);
      expect(result.auth.partnerOrgAccess).toBe(orgAccess);
      expect(result.toolAuth.canAccessOrg('org-current-sibling')).toBe(true);
      expect(result.toolAuth.canAccessOrg('org-stale-sibling')).toBe(false);
    }
  });

  it('denies partner none when the current target org is absent from recomputed reach', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({
      permissions: [], partnerId: 'partner-current', orgId: 'org-1', roleId: 'role-new',
      scope: 'partner', orgAccess: 'none',
    });
    vi.mocked(computeAccessibleOrgIds).mockResolvedValue({ orgIds: [], partnerOrgAccess: 'none' });

    await expect(resolveLiveSessionToolAuthority(
      session({ auth: { ...session().auth, scope: 'partner', partnerId: 'partner-stale', orgId: null } }),
      'manage_alerts', { action: 'resolve' },
    )).resolves.toEqual({ ok: false, reason: 'Organization authority was removed' });
    expect(checkToolPermissionForResolvedUser).not.toHaveBeenCalled();
  });

  it('denies when the partner membership disappears during current-reach resolution', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({
      permissions: [], partnerId: 'partner-current', orgId: 'org-1', roleId: 'role-new',
      scope: 'partner', orgAccess: 'all',
    });
    vi.mocked(computeAccessibleOrgIds).mockResolvedValue({ orgIds: ['org-1'], partnerOrgAccess: null });

    await expect(resolveLiveSessionToolAuthority(
      session({ auth: { ...session().auth, scope: 'partner', partnerId: 'partner-stale', orgId: null } }),
      'manage_alerts', { action: 'resolve' },
    )).resolves.toEqual({ ok: false, reason: 'Organization authority was removed' });
    expect(checkToolPermissionForResolvedUser).not.toHaveBeenCalled();
  });

  it('falls back from a removed partner membership to a direct current-org membership', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({
      permissions: [], partnerId: 'partner-current', orgId: 'org-1', roleId: 'org-role',
      scope: 'organization', allowedSiteIds: ['site-new'],
    });

    const result = await resolveLiveSessionToolAuthority(
      session({ auth: { ...session().auth, scope: 'partner', partnerId: 'partner-stale', orgId: null } }),
      'manage_alerts', { action: 'resolve' },
    );

    expect(result.ok).toBe(true);
    expect(computeAccessibleOrgIds).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.auth.scope).toBe('organization');
      expect(result.auth.partnerId).toBeNull();
      expect(result.auth.orgId).toBe('org-1');
      expect(result.auth.accessibleOrgIds).toEqual(['org-1']);
    }
  });

  it('does not promote an organization session through a partner membership', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);

    await expect(resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' }))
      .resolves.toEqual({ ok: false, reason: 'Organization authority was removed' });
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', expect.objectContaining({ partnerId: undefined }));
  });

  it('uses the current owner and denies an old-partner-only user after the organization moves', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);

    await expect(resolveLiveSessionToolAuthority(
      session({ auth: { ...session().auth, scope: 'partner', partnerId: 'partner-old', orgId: null } }),
      'manage_alerts', { action: 'resolve' },
    )).resolves.toEqual({ ok: false, reason: 'Organization authority was removed' });
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', expect.objectContaining({
      orgId: 'org-1', partnerId: 'partner-current', bypassCache: true,
    }));
  });

  it('guards the organization read on live status and deletedAt, without a row lock', async () => {
    const result = await resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' });
    expect(result.ok).toBe(true);

    // Discriminating on the CONDITION, not on the mock's return value: the
    // stub returns whatever it is told regardless of the WHERE, so asserting
    // "no row came back" proves nothing about the guard that is meant to
    // exclude it. Render the built predicate and read the bound params.
    const { sql, params } = renderSql(capturedWhere.org);
    expect(sql).toMatch(/"id" = \$\d/);
    expect(sql).toMatch(/"status" in /i);
    expect(sql).toMatch(/"deleted_at" is null/i);
    expect(params).toEqual(expect.arrayContaining(['org-1', 'active', 'trial']));
    // A suspended/archived org must NOT satisfy the status predicate.
    expect(params).not.toContain('suspended');

    const userQuery = renderSql(capturedWhere.user);
    expect(userQuery.params).toEqual(expect.arrayContaining(['user-1']));
  });

  it('denies before membership and tool checks when the organization read returns nothing', async () => {
    orgRows = [];

    await expect(resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' }))
      .resolves.toEqual({ ok: false, reason: 'Organization authority was removed' });
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(checkToolPermissionForResolvedUser).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'disabled', 'pending'])('denies release when the user status is %s', async (status) => {
    userRows = [{ status, isPlatformAdmin: false }];

    await expect(resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' }))
      .resolves.toEqual({ ok: false, reason: 'User is no longer active' });
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(checkToolPermissionForResolvedUser).not.toHaveBeenCalled();
  });

  it('denies release when the user row is gone entirely', async () => {
    userRows = [];

    await expect(resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' }))
      .resolves.toEqual({ ok: false, reason: 'User is no longer active' });
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('denies a non-user principal before any database read', async () => {
    const helper = session({ auth: { ...session().auth, principal: { kind: 'helper_token' } } });

    await expect(resolveLiveSessionToolAuthority(helper, 'manage_alerts', { action: 'resolve' }))
      .resolves.toEqual({ ok: false, reason: 'Interactive session authority could not be verified' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('pins tool authority to the device organization when the session is device-bound', async () => {
    vi.mocked(computeAccessibleOrgIds).mockResolvedValue({
      orgIds: ['org-1', 'org-sibling'], partnerOrgAccess: 'all',
    });
    vi.mocked(getUserPermissions).mockResolvedValue({
      permissions: [], partnerId: 'partner-current', orgId: 'org-1', roleId: 'role-new',
      scope: 'partner', orgAccess: 'all',
    } as never);

    const result = await resolveLiveSessionToolAuthority(
      session({
        deviceId: 'device-9',
        auth: { ...session().auth, scope: 'partner', partnerId: 'partner-stale', orgId: null },
      }),
      'manage_alerts', { action: 'resolve' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The user's own reach stays wide...
      expect(result.auth.accessibleOrgIds).toEqual(['org-1', 'org-sibling']);
      // ...but the TOOL is bound to the device's org (#3087).
      expect(result.toolAuth.accessibleOrgIds).toEqual(['org-1']);
      expect(result.toolAuth.orgId).toBe('org-1');
      expect(result.toolAuth.canAccessOrg('org-sibling')).toBe(false);
    }
  });

  describe('system-scoped (platform admin) sessions', () => {
    function systemSession(overrides: Record<string, unknown> = {}) {
      const base = session(overrides);
      return { ...base, auth: { ...base.auth, scope: 'system', orgId: null }, toolAuth: base.toolAuth };
    }

    it('re-reads the live platform-admin flag and skips the tenant tool-permission check', async () => {
      userRows = [{ status: 'active', isPlatformAdmin: true }];

      const result = await resolveLiveSessionToolAuthority(systemSession(), 'manage_alerts', { action: 'resolve' });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.auth.user.isPlatformAdmin).toBe(true);
      // Platform admins are authorized by the grant itself; there is no tenant
      // permission set to resolve against.
      expect(checkToolPermissionForResolvedUser).not.toHaveBeenCalled();
      expect(getUserPermissions).not.toHaveBeenCalled();
    });

    it('denies release when platform authority was revoked mid-session', async () => {
      userRows = [{ status: 'active', isPlatformAdmin: false }];

      await expect(resolveLiveSessionToolAuthority(systemSession(), 'manage_alerts', { action: 'resolve' }))
        .resolves.toEqual({ ok: false, reason: 'Platform authority was removed' });
    });

    it('keeps a device-bound platform admin pinned to the device organization', async () => {
      userRows = [{ status: 'active', isPlatformAdmin: true }];

      const result = await resolveLiveSessionToolAuthority(
        systemSession({ deviceId: 'device-9' }), 'manage_alerts', { action: 'resolve' },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // THE REGRESSION this guards: the system branch used to return the
        // session auth as toolAuth verbatim, widening a device-bound platform
        // admin to full system reach on the first Tier-2 release (#3087).
        expect(result.toolAuth.accessibleOrgIds).toEqual(['org-1']);
        expect(result.toolAuth.orgId).toBe('org-1');
        expect(result.toolAuth.canAccessOrg('org-other')).toBe(false);
        expect(result.auth.scope).toBe('system');
      }
    });
  });
});
