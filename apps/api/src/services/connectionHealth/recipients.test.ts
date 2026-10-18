import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePartnerUsersMock = vi.fn();
const resolveOrgUsersMock = vi.fn();
const customerAdminsMock = vi.fn();
const selectWhereMock = vi.fn();

vi.mock('../usersWithPermission', () => ({
  resolvePartnerUsersWithPermission: (...a: unknown[]) => resolvePartnerUsersMock(...a),
  resolveUsersWithPermissionForOrg: (...a: unknown[]) => resolveOrgUsersMock(...a),
}));
vi.mock('./customerDelivery', () => ({
  resolveCustomerAdminsNotified: (...a: unknown[]) => customerAdminsMock(...a),
}));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: (...a: unknown[]) => selectWhereMock(...a) }) }) },
}));
vi.mock('../../db/schema', () => ({ users: { id: 'id', status: 'status' } }));

import { resolveIncidentRecipients } from './recipients';

describe('resolveIncidentRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customerAdminsMock.mockResolvedValue(false);
  });

  it('partner-wide incident: admins, owner separately, owner not duplicated', async () => {
    resolvePartnerUsersMock.mockResolvedValue(['u1', 'owner']);
    selectWhereMock.mockResolvedValue([{ id: 'owner' }]);
    expect(
      await resolveIncidentRecipients({ partnerId: 'P', orgId: null, ownerUserId: 'owner', repairPermission: 'connected_apps:manage' }),
    ).toEqual({ admins: ['u1'], owner: 'owner' });
    expect(resolvePartnerUsersMock).toHaveBeenCalledWith('P', { resource: 'connected_apps', action: 'manage' }, {});
  });

  it('org incident passes orgId through', async () => {
    resolvePartnerUsersMock.mockResolvedValue(['u1']);
    await resolveIncidentRecipients({ partnerId: 'P', orgId: 'A', ownerUserId: null, repairPermission: 'organizations:write' });
    expect(resolvePartnerUsersMock).toHaveBeenCalledWith('P', { resource: 'organizations', action: 'write' }, { orgId: 'A' });
    expect(selectWhereMock).not.toHaveBeenCalled();
  });

  it('inactive owner is dropped', async () => {
    resolvePartnerUsersMock.mockResolvedValue(['u1']);
    selectWhereMock.mockResolvedValue([]);
    expect(
      await resolveIncidentRecipients({ partnerId: 'P', orgId: null, ownerUserId: 'gone', repairPermission: 'connected_apps:manage' }),
    ).toEqual({ admins: ['u1'], owner: null });
  });

  it('active owner is in owner, not in admins', async () => {
    resolvePartnerUsersMock.mockResolvedValue(['u1', 'owner']);
    selectWhereMock.mockResolvedValue([{ id: 'owner' }]);
    const r = await resolveIncidentRecipients({ partnerId: 'P', orgId: null, ownerUserId: 'owner', repairPermission: 'connected_apps:manage' });
    expect(r.owner).toBe('owner');
    expect(r.admins).not.toContain('owner');
  });

  describe('customerAdminsNotified (W5)', () => {
    it('off: an org incident reaches partner-scope users only', async () => {
      resolvePartnerUsersMock.mockResolvedValue(['staff']);
      const r = await resolveIncidentRecipients({ partnerId: 'P', orgId: 'A', ownerUserId: null, repairPermission: 'organizations:write' });
      expect(customerAdminsMock).toHaveBeenCalledWith('A');
      expect(resolveOrgUsersMock).not.toHaveBeenCalled();
      expect(r.admins).toEqual(['staff']);
    });

    it('on: an org incident reaches every holder of the repair permission for the org, org members included', async () => {
      customerAdminsMock.mockResolvedValue(true);
      resolveOrgUsersMock.mockResolvedValue(['staff', 'customer-admin']);
      const r = await resolveIncidentRecipients({ partnerId: 'P', orgId: 'A', ownerUserId: null, repairPermission: 'organizations:write' });
      expect(resolveOrgUsersMock).toHaveBeenCalledWith('A', { resource: 'organizations', action: 'write' });
      expect(resolvePartnerUsersMock).not.toHaveBeenCalled();
      expect(r.admins).toEqual(['staff', 'customer-admin']);
    });

    it('on: the owner is still reported separately, never twice', async () => {
      customerAdminsMock.mockResolvedValue(true);
      resolveOrgUsersMock.mockResolvedValue(['owner', 'customer-admin']);
      selectWhereMock.mockResolvedValue([{ id: 'owner' }]);
      const r = await resolveIncidentRecipients({ partnerId: 'P', orgId: 'A', ownerUserId: 'owner', repairPermission: 'connected_apps:manage' });
      expect(r).toEqual({ admins: ['customer-admin'], owner: 'owner' });
    });

    it('a partner-wide incident never consults the setting or reaches org members', async () => {
      resolvePartnerUsersMock.mockResolvedValue(['staff']);
      await resolveIncidentRecipients({ partnerId: 'P', orgId: null, ownerUserId: null, repairPermission: 'organizations:write' });
      expect(customerAdminsMock).not.toHaveBeenCalled();
      expect(resolveOrgUsersMock).not.toHaveBeenCalled();
    });
  });
});
