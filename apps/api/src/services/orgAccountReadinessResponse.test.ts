import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveAcceptedOrgs = vi.fn();
const loadAccountReadiness = vi.fn();
const computeAccountReadinessExtras = vi.fn();
vi.mock('./orgAccountReadiness', () => ({
  resolveAcceptedOrgs: (...a: unknown[]) => resolveAcceptedOrgs(...a),
  loadAccountReadiness: (...a: unknown[]) => loadAccountReadiness(...a),
}));
vi.mock('./orgAccountReadinessExtras', () => ({
  computeAccountReadinessExtras: (...a: unknown[]) => computeAccountReadinessExtras(...a),
  extrasForOrg: () => ({}),
}));
vi.mock('./serviceManagement', () => ({ getServiceManagementMode: vi.fn(async () => 'native') }));
vi.mock('./billingEnabled', () => ({ isBillingEnabledForPartner: vi.fn(async () => true) }));

import { buildAccountReadinessResponse } from './orgAccountReadinessResponse';

const org = { id: 'o-1', type: 'customer', status: 'active', billingAddress: true };

beforeEach(() => {
  resolveAcceptedOrgs.mockReset().mockResolvedValue([org]);
  loadAccountReadiness.mockReset().mockResolvedValue(new Map([['o-1', { sites: 2, devices: 5, lastSeenAt: null, policyAssigned: true, primaryContact: null, billingRoleContact: false, pendingInvitations: 1, overdueInvoices: 0 }]]));
  computeAccountReadinessExtras.mockReset().mockResolvedValue({});
});

describe('buildAccountReadinessResponse (W18, #6789)', () => {
  it('readiness capabilities false without their grant; no section computed', async () => {
    const response = await buildAccountReadinessResponse({ partnerId: 'p-1', orgIds: ['o-1'], accessibleOrgIds: ['o-1'], can: () => false });
    expect(response.capabilities).toEqual({
      sites: false, devices: false, policies: true, contacts: true, portalUsers: false,
      invoices: false, tickets: false, integrations: false, contracts: false, backup: false,
    });
    expect(loadAccountReadiness).toHaveBeenCalledWith(expect.objectContaining({
      sections: { sites: false, devices: false, portalUsers: false, invoices: false, tickets: false },
    }));
    const [shaped] = response.orgs;
    expect(shaped!.setup).toEqual({ policyAssigned: true });
    expect(Object.keys(shaped!.account)).not.toContain('pendingInvitations');
    expect(shaped!.tickets).toBeUndefined();
  });

  it('an org outside accessibleOrgIds is dropped, and a null list only for system', async () => {
    await buildAccountReadinessResponse({ partnerId: 'p-1', orgIds: ['o-1', 'o-2'], accessibleOrgIds: ['o-1'], can: () => true });
    expect(resolveAcceptedOrgs).toHaveBeenLastCalledWith({ orgIds: ['o-1', 'o-2'], partnerId: 'p-1', accessibleOrgIds: ['o-1'] });
    await buildAccountReadinessResponse({ partnerId: 'p-1', orgIds: ['o-1'], accessibleOrgIds: null, can: () => true });
    expect(resolveAcceptedOrgs).toHaveBeenLastCalledWith({ orgIds: ['o-1'], partnerId: 'p-1', accessibleOrgIds: null });
  });

  it('no accepted org skips the signal queries', async () => {
    resolveAcceptedOrgs.mockResolvedValue([]);
    const response = await buildAccountReadinessResponse({ partnerId: 'p-1', orgIds: ['o-9'], accessibleOrgIds: [], can: () => true });
    expect(response.orgs).toEqual([]);
    expect(loadAccountReadiness).not.toHaveBeenCalled();
  });

  it('granted sections are shaped', async () => {
    const response = await buildAccountReadinessResponse({ partnerId: 'p-1', orgIds: ['o-1'], accessibleOrgIds: ['o-1'], can: () => true });
    expect(response.orgs[0]).toMatchObject({ setup: { sites: 2, devices: 5 }, account: { pendingInvitations: 1, overdueInvoices: 0 }, tickets: { open: 0 } });
  });
});
