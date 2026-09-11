import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLiveSessionToolAuthority } from './aiSessionLiveAuthority';
import { canAccessOrg, getUserPermissions } from './permissions';
import { checkToolPermissionForResolvedUser } from './aiGuardrails';
import { computeAccessibleOrgIds } from '../middleware/auth';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withSystemDbAccessContext: vi.fn((fn) => fn()),
  db: { select: vi.fn() },
}));
vi.mock('../db/schema', () => ({
  users: { id: 'users.id', status: 'users.status', isPlatformAdmin: 'users.isPlatformAdmin' },
  organizations: {
    id: 'organizations.id', partnerId: 'organizations.partnerId', status: 'organizations.status', deletedAt: 'organizations.deletedAt',
  },
}));
vi.mock('./permissions', () => ({ getUserPermissions: vi.fn(), canAccessOrg: vi.fn() }));
vi.mock('./aiGuardrails', () => ({ checkToolPermissionForResolvedUser: vi.fn() }));
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  computeAccessibleOrgIds: vi.fn(),
}));
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: vi.fn(),
}));

const { db } = await import('../db');

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
  vi.mocked(db.select).mockImplementation((columns?: Record<string, unknown>) => {
    const rows = columns && 'isPlatformAdmin' in columns
      ? [{ status: 'active', isPlatformAdmin: false }]
      : [{ id: 'org-1', partnerId: 'partner-current' }];
    const isUserProjection = Boolean(columns && 'isPlatformAdmin' in columns);
    const chain: any = {
      from: vi.fn(() => chain), where: vi.fn(() => chain),
      limit: isUserProjection ? vi.fn(async () => rows) : vi.fn(() => chain),
      for: vi.fn(async () => rows),
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

  it.each(['moved', 'deleted', 'suspended'])('denies when the target organization is %s before membership/tool checks', async () => {
    vi.mocked(db.select).mockImplementation((columns?: Record<string, unknown>) => {
      const rows = columns && 'isPlatformAdmin' in columns
        ? [{ status: 'active', isPlatformAdmin: false }]
        : [];
      const isUserProjection = Boolean(columns && 'isPlatformAdmin' in columns);
      const chain: any = {
        from: vi.fn(() => chain), where: vi.fn(() => chain),
        limit: isUserProjection ? vi.fn(async () => rows) : vi.fn(() => chain),
        for: vi.fn(async () => rows),
      };
      return chain;
    });

    await expect(resolveLiveSessionToolAuthority(session(), 'manage_alerts', { action: 'resolve' }))
      .resolves.toEqual({ ok: false, reason: 'Organization authority was removed' });
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(checkToolPermissionForResolvedUser).not.toHaveBeenCalled();
  });
});
