import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  userRows: [] as Array<Record<string, unknown>>,
  getUserPermissions: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.userRows),
        }),
      }),
    })),
  },
}));

vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: state.getUserPermissions };
});

import { resolveMergePerformerRefusal } from './orgMergePerformerAuthority';

const INPUT = {
  loserOrgId: 'org-loser',
  survivorOrgId: 'org-survivor',
  partnerId: 'partner-1',
  performedBy: 'user-1',
};

const ORGS_WRITE = { resource: 'organizations', action: 'write' };

function partnerPerms(over: Record<string, unknown> = {}) {
  return {
    permissions: [ORGS_WRITE],
    partnerId: 'partner-1',
    orgId: null,
    roleId: 'role-1',
    scope: 'partner',
    orgAccess: 'all',
    ...over,
  };
}

function user(over: Record<string, unknown> = {}) {
  return { id: 'user-1', status: 'active', partnerId: 'partner-1', isPlatformAdmin: false, ...over };
}

describe('resolveMergePerformerRefusal', () => {
  beforeEach(() => {
    state.userRows = [user()];
    state.getUserPermissions.mockReset();
    state.getUserPermissions.mockResolvedValue(partnerPerms());
  });

  it('admits an active partner member who still holds organizations:write over both organizations', async () => {
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBeNull();
    // Live read, never a cached grant set, on the partner axis the route used.
    expect(state.getUserPermissions).toHaveBeenCalledWith(
      'user-1',
      { partnerId: 'partner-1', scope: 'partner' },
      { bypassCache: true },
    );
  });

  it('refuses a performer whose user row no longer exists', async () => {
    state.userRows = [];
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_not_found');
  });

  it.each(['disabled', 'invited'])('refuses a performer whose status is %s', async (status) => {
    state.userRows = [user({ status })];
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_inactive');
    expect(state.getUserPermissions).not.toHaveBeenCalled();
  });

  it('refuses a deactivated platform admin', async () => {
    state.userRows = [user({ status: 'disabled', isPlatformAdmin: true })];
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_inactive');
  });

  it('refuses a performer who now belongs to a different partner', async () => {
    state.userRows = [user({ partnerId: 'partner-2' })];
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_not_in_partner');
  });

  it('refuses a performer with no remaining partner membership', async () => {
    state.getUserPermissions.mockResolvedValue(null);
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_not_in_partner');
  });

  it('refuses a performer whose membership resolves on a non-partner axis', async () => {
    state.getUserPermissions.mockResolvedValue(partnerPerms({ scope: 'organization', orgId: 'org-loser' }));
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_not_in_partner');
  });

  it('refuses a performer whose role no longer grants organizations:write', async () => {
    state.getUserPermissions.mockResolvedValue(partnerPerms({ permissions: [{ resource: 'organizations', action: 'read' }] }));
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_lacks_permission');
  });

  it('refuses a performer whose org selection no longer covers the loser', async () => {
    state.getUserPermissions.mockResolvedValue(
      partnerPerms({ orgAccess: 'selected', allowedOrgIds: ['org-survivor'] }),
    );
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_lacks_org_access');
  });

  it('refuses a performer whose org selection no longer covers the survivor', async () => {
    state.getUserPermissions.mockResolvedValue(
      partnerPerms({ orgAccess: 'selected', allowedOrgIds: ['org-loser'] }),
    );
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_lacks_org_access');
  });

  it('refuses a performer whose org access was set to none', async () => {
    state.getUserPermissions.mockResolvedValue(partnerPerms({ orgAccess: 'none' }));
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_lacks_org_access');
  });

  it('admits a performer whose selection still covers both organizations', async () => {
    state.getUserPermissions.mockResolvedValue(
      partnerPerms({ orgAccess: 'selected', allowedOrgIds: ['org-loser', 'org-survivor'] }),
    );
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBeNull();
  });

  it('admits an active platform admin of another partner through the system-scope grant', async () => {
    state.userRows = [user({ partnerId: 'partner-home', isPlatformAdmin: true })];
    state.getUserPermissions.mockResolvedValue({
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: null,
      roleId: 'platform-admin',
      scope: 'system',
    });
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBeNull();
    expect(state.getUserPermissions).toHaveBeenCalledWith('user-1', { scope: 'system' }, { bypassCache: true });
  });

  it('refuses a former platform admin of another partner whose system grant no longer resolves', async () => {
    state.userRows = [user({ partnerId: 'partner-home', isPlatformAdmin: true })];
    state.getUserPermissions.mockResolvedValue(null);
    await expect(resolveMergePerformerRefusal(INPUT)).resolves.toBe('performer_not_in_partner');
  });
});
