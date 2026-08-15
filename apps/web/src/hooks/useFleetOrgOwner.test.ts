import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFleetOrgOwner } from './useFleetOrgOwner';
import { useOrgStore, type Organization } from '../stores/orgStore';

const acme: Organization = {
  id: 'org-1',
  partnerId: 'p-1',
  name: 'Acme Corp',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

const zeta: Organization = {
  id: 'org-2',
  partnerId: 'p-1',
  name: 'Zeta Ltd',
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

describe('useFleetOrgOwner', () => {
  beforeEach(() => {
    seed({});
  });

  it('explicit All-orgs view: picker required, no owner chosen yet', () => {
    seed({ allOrgs: true, organizations: [acme, zeta], organizationsLoaded: true });
    const { result } = renderHook(() => useFleetOrgOwner());
    expect(result.current.isFleetScope).toBe(true);
    expect(result.current.needsOrgSelection).toBe(true);
    expect(result.current.bodyOrgId).toBeUndefined();
  });

  it('choosing an org in fleet scope clears the requirement and supplies bodyOrgId', () => {
    seed({ allOrgs: true, organizations: [acme, zeta], organizationsLoaded: true });
    const { result } = renderHook(() => useFleetOrgOwner());
    act(() => result.current.setOrgId('org-2'));
    expect(result.current.needsOrgSelection).toBe(false);
    expect(result.current.bodyOrgId).toBe('org-2');
  });

  it('concrete-org scope: no picker, has a resolvable owner, never sends orgId', () => {
    seed({ currentOrgId: 'org-1', organizations: [acme], organizationsLoaded: true });
    const { result } = renderHook(() => useFleetOrgOwner());
    expect(result.current.isFleetScope).toBe(false);
    expect(result.current.needsOrgSelection).toBe(false);
    expect(result.current.bodyOrgId).toBeUndefined();
  });

  // Regression guard: the pre-hydration null (list not loaded, All-orgs not
  // chosen) must NOT flash the picker — the scope is about to resolve. But the
  // create has no owner yet, so it must stay blocked (no opaque 400).
  it('pre-hydration / loading: no picker, but create is blocked (no owner yet)', () => {
    seed({}); // currentOrgId null, allOrgs false, list not loaded → loading
    const { result } = renderHook(() => useFleetOrgOwner());
    expect(result.current.isFleetScope).toBe(false);
    expect(result.current.needsOrgSelection).toBe(true);
    expect(result.current.bodyOrgId).toBeUndefined();
  });

  // Org-list load failure while the page stays usable: still no injectable org,
  // so the create must stay blocked rather than 400.
  it('org-list error state: create blocked, no picker', () => {
    seed({ error: 'Failed to fetch organizations' });
    const { result } = renderHook(() => useFleetOrgOwner());
    expect(result.current.isFleetScope).toBe(false);
    expect(result.current.needsOrgSelection).toBe(true);
  });

  // Finding 6: a pick that drops out of the accessible org list (partner switch,
  // refetch) must NOT survive as the owner.
  it('drops a selection that is no longer in the org list', () => {
    seed({ allOrgs: true, organizations: [acme, zeta], organizationsLoaded: true });
    const { result, rerender } = renderHook(() => useFleetOrgOwner());
    act(() => result.current.setOrgId('org-2'));
    expect(result.current.orgId).toBe('org-2');
    expect(result.current.needsOrgSelection).toBe(false);

    // org-2 disappears from the accessible list.
    act(() => seed({ allOrgs: true, organizations: [acme], organizationsLoaded: true }));
    rerender();
    expect(result.current.orgId).toBe('');
    expect(result.current.needsOrgSelection).toBe(true);
    expect(result.current.bodyOrgId).toBeUndefined();

    // And it must NOT resurrect if org-2 later reappears — the effect cleared
    // the raw pick, so the user has to choose again.
    act(() => seed({ allOrgs: true, organizations: [acme, zeta], organizationsLoaded: true }));
    rerender();
    expect(result.current.orgId).toBe('');
    expect(result.current.needsOrgSelection).toBe(true);
    expect(result.current.bodyOrgId).toBeUndefined();
  });

  it('sorts the org list by name for the picker', () => {
    seed({ allOrgs: true, organizations: [zeta, acme], organizationsLoaded: true });
    const { result } = renderHook(() => useFleetOrgOwner());
    expect(result.current.organizations.map((o) => o.id)).toEqual(['org-1', 'org-2']);
  });
});
