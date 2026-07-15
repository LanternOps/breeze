import { describe, it, expect, vi, beforeEach } from 'vitest';

// `apiKeyScopes.ts` (exercised for real below — it is NOT mocked) also imports
// PERMISSIONS/hasPermission from this module, so a full-replacement factory
// would blank those out for every importer in the graph. Keep the real
// exports via importOriginal and only override getUserPermissions.
vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(),
  };
});

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  servicePrincipals: { id: 'id', status: 'status', scopes: 'scopes' },
}));

import { authorizeHumanApiKeyCreator, authorizeServicePrincipalKey } from './apiKeyAuthorization';
import { getUserPermissions } from './permissions';
import { db } from '../db';
import type { UserPermissions } from './permissions';

const buildSelectMock = (result: unknown[]) =>
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);

// A creator who holds devices:read + devices:write on the org axis.
const fullPerms: UserPermissions = {
  permissions: [
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
  ],
  partnerId: null,
  orgId: 'org-1',
  roleId: 'role-1',
  scope: 'organization',
  allowedSiteIds: ['site-a'],
} as UserPermissions;

describe('authorizeHumanApiKeyCreator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes when the creator still holds every stored scope, returning live allowedSiteIds', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(fullPerms);
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read', 'devices:write'],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.allowedSiteIds).toEqual(['site-a']);
      expect(res.clampedScopes).toEqual(['devices:read', 'devices:write']);
    }
    // Both axes offered so a partner-admin creator (no org row) still resolves.
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', { orgId: 'org-1', partnerId: 'partner-1' });
  });

  it('DENIES (no_membership) when the creator has no live membership on either axis (null perms) — the off-boarding gate and the fail-closed rule', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read'],
    });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });

  it('DENIES (scope_exceeds_current_permissions) when the creator no longer holds a stored scope (permission reduction re-clamp)', async () => {
    const reduced = { ...fullPerms, permissions: [{ resource: 'devices', action: 'read' }] } as UserPermissions;
    vi.mocked(getUserPermissions).mockResolvedValue(reduced);
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read', 'devices:write'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('scope_exceeds_current_permissions');
  });

  it('FAILS CLOSED (no_membership) when the permission read THROWS (DB/RLS error), never authorizing', async () => {
    vi.mocked(getUserPermissions).mockRejectedValue(new Error('RLS/DB down'));
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read'],
    });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });
});

describe('authorizeServicePrincipalKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes when the principal is active and the stored scopes are a subset of its current scopes', async () => {
    buildSelectMock([{ status: 'active', scopes: ['ai:read', 'devices:read'] }]);
    const res = await authorizeServicePrincipalKey({ principalId: 'principal-1', scopes: ['ai:read'] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.clampedScopes).toEqual(['ai:read']);
      expect(res.allowedSiteIds).toBeUndefined();
      expect(res.permissions).toBeNull();
    }
  });

  // Guard-bite (a): a disabled principal's key is rejected.
  it('DENIES (no_membership) when the principal status is not active (disable-cascade gate)', async () => {
    buildSelectMock([{ status: 'disabled', scopes: ['ai:read'] }]);
    const res = await authorizeServicePrincipalKey({ principalId: 'principal-1', scopes: ['ai:read'] });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });

  // Guard-bite (d): fail-closed on a missing/errored principal read.
  it('DENIES (no_membership) when the principal row is missing', async () => {
    buildSelectMock([]);
    const res = await authorizeServicePrincipalKey({ principalId: 'principal-missing', scopes: ['ai:read'] });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });

  it('FAILS CLOSED (no_membership) when the principal read THROWS (DB/RLS error), never authorizing', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('RLS/DB down');
    });
    const res = await authorizeServicePrincipalKey({ principalId: 'principal-1', scopes: ['ai:read'] });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });

  // Guard-bite (b): a service key's stored scope not covered by the
  // principal's CURRENT scopes is rejected — this is a plain subset check
  // against the principal's own ceiling, never a human permission lookup.
  it('DENIES (scope_exceeds_current_permissions) when a stored scope is not in the principal\'s current scopes', async () => {
    buildSelectMock([{ status: 'active', scopes: ['ai:read'] }]);
    const res = await authorizeServicePrincipalKey({
      principalId: 'principal-1',
      scopes: ['ai:read', 'ai:execute_admin'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('scope_exceeds_current_permissions');
      expect(res.detail).toMatchObject({ exceededScopes: ['ai:execute_admin'] });
    }
  });

  it('reads the principal under withSystemDbAccessContext (auth path runs before request RLS context)', async () => {
    const { withSystemDbAccessContext } = await import('../db');
    buildSelectMock([{ status: 'active', scopes: ['ai:read'] }]);
    await authorizeServicePrincipalKey({ principalId: 'principal-1', scopes: ['ai:read'] });
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });
});
