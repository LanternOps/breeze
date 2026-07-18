import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { getJwtClaimsMock } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn<() => { scope: 'system' | 'partner' | 'organization' | null; partnerId: string | null; orgId: string | null }>(
    () => ({ scope: 'partner', partnerId: 'p-1', orgId: null })
  ),
}));
vi.mock('../lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('../lib/authScope')>('../lib/authScope');
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});

import { useDefaultOwnerScope } from './useDefaultOwnerScope';
import { useOrgStore, type Organization } from '../stores/orgStore';

const acme: Organization = {
  id: 'org-1',
  partnerId: 'p-1',
  name: 'Acme Corp',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

function seed(partial: Partial<ReturnType<typeof useOrgStore.getState>>) {
  useOrgStore.setState({
    currentOrgId: null,
    allOrgs: false,
    organizations: [],
    organizationsLoaded: false,
    error: null,
    ...partial,
  });
}

describe('useDefaultOwnerScope', () => {
  beforeEach(() => {
    seed({});
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
  });

  it('partner scope + explicit fleet view → defaults to partner-wide', () => {
    seed({ allOrgs: true });
    const { result } = renderHook(() => useDefaultOwnerScope());
    expect(result.current.isPartnerScope).toBe(true);
    expect(result.current.defaultOwnerScope).toBe('partner');
  });

  it('partner scope + a concrete org selected → defaults to org-owned', () => {
    seed({ currentOrgId: 'org-1', organizations: [acme] });
    const { result } = renderHook(() => useDefaultOwnerScope());
    expect(result.current.defaultOwnerScope).toBe('organization');
  });

  // The regression guard: the pre-hydration null must NOT default a partner
  // user's form to partner-wide (the old `allOrgs || !currentOrgId` bug).
  it('partner scope during the unresolved window → defaults to org-owned, not partner-wide', () => {
    seed({}); // currentOrgId null, allOrgs false, list not loaded → loading
    const { result } = renderHook(() => useDefaultOwnerScope());
    expect(result.current.isPartnerScope).toBe(true);
    expect(result.current.defaultOwnerScope).toBe('organization');
  });

  it('org-scope token → never partner scope, always org-owned even with a null context', () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: 'p-1', orgId: 'org-1' });
    seed({ allOrgs: true });
    const { result } = renderHook(() => useDefaultOwnerScope());
    expect(result.current.isPartnerScope).toBe(false);
    expect(result.current.defaultOwnerScope).toBe('organization');
  });
});
