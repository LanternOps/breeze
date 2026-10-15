import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePartnerUsersMock = vi.fn();
const selectWhereMock = vi.fn();

vi.mock('../usersWithPermission', () => ({
  resolvePartnerUsersWithPermission: (...a: unknown[]) => resolvePartnerUsersMock(...a),
}));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: (...a: unknown[]) => selectWhereMock(...a) }) }) },
}));
vi.mock('../../db/schema', () => ({ users: { id: 'id', status: 'status' } }));

import { resolveIncidentRecipients } from './recipients';

describe('resolveIncidentRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('inactive owner who is also an admin candidate stays in admins only if resolver returned them', async () => {
    resolvePartnerUsersMock.mockResolvedValue(['u1', 'gone']);
    selectWhereMock.mockResolvedValue([]);
    expect(
      await resolveIncidentRecipients({ partnerId: 'P', orgId: null, ownerUserId: 'gone', repairPermission: 'connected_apps:manage' }),
    ).toEqual({ admins: ['u1', 'gone'], owner: null });
  });
});
