import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn()
}));

import { fetchWithAuth } from './auth';
import { getCurrentOrganization, useOrgStore } from './orgStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('org store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-org');
    useOrgStore.setState({
      currentPartnerId: null,
      currentOrgId: null,
      allOrgs: false,
      lastOrgId: null,
      partners: [],
      organizations: [],
      organizationsLoaded: false,
      sites: [],
      isLoading: false,
      error: null
    });
  });

  it('fetchOrganizations auto-selects first org and loads its sites', async () => {
    useOrgStore.setState({ currentPartnerId: 'partner-1' });

    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeResponse({
          data: [{ id: 'org-1', partnerId: 'partner-1', name: 'Org One', status: 'active' }]
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: [
            {
              id: 'site-1',
              organizationId: 'org-1',
              name: 'HQ',
              status: 'active',
              deviceCount: 10
            }
          ]
        })
      );

    await useOrgStore.getState().fetchOrganizations();
    await flushAsync();

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/organizations?partnerId=partner-1');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/sites?organizationId=org-1');
    expect(useOrgStore.getState().currentOrgId).toBe('org-1');
    expect(useOrgStore.getState().sites).toHaveLength(1);
    expect(getCurrentOrganization()?.id).toBe('org-1');
  });

  it('keeps explicit All-orgs scope across a re-fetch (does not snap back to first org)', async () => {
    // The All-orgs pill clears the selection: currentOrgId null + allOrgs true.
    useOrgStore.getState().setOrganization('');
    expect(useOrgStore.getState().currentOrgId).toBeNull();
    expect(useOrgStore.getState().allOrgs).toBe(true);

    useOrgStore.setState({ currentPartnerId: 'partner-1' });
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({
        data: [{ id: 'org-1', partnerId: 'partner-1', name: 'Org One', status: 'active' }]
      })
    );

    await useOrgStore.getState().fetchOrganizations();
    await flushAsync();

    // Auto-select must be suppressed so the user's All-orgs choice survives the
    // post-switch reload instead of silently jumping to org-1.
    expect(useOrgStore.getState().currentOrgId).toBeNull();
    expect(useOrgStore.getState().allOrgs).toBe(true);
  });

  it('clearOrgContext resets the persisted scope fields (no cross-session leak)', () => {
    useOrgStore.getState().setOrganization('org-9');
    useOrgStore.getState().setOrganization(''); // explicit All-orgs
    expect(useOrgStore.getState().allOrgs).toBe(true);
    expect(useOrgStore.getState().lastOrgId).toBe('org-9');

    useOrgStore.getState().clearOrgContext();

    // A logout must not leave All-orgs / a stale lastOrgId for the next user.
    expect(useOrgStore.getState().allOrgs).toBe(false);
    expect(useOrgStore.getState().lastOrgId).toBeNull();
    expect(useOrgStore.getState().currentOrgId).toBeNull();
  });

  it('selecting a concrete org records it as lastOrgId and clears All-orgs', () => {
    useOrgStore.getState().setOrganization('');
    expect(useOrgStore.getState().allOrgs).toBe(true);

    useOrgStore.getState().setOrganization('org-7');

    expect(useOrgStore.getState().currentOrgId).toBe('org-7');
    expect(useOrgStore.getState().allOrgs).toBe(false);
    expect(useOrgStore.getState().lastOrgId).toBe('org-7');
  });

  it('fetchPartners uses orgs route and auto-selects first partner', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeResponse({
          data: [{ id: 'partner-1', name: 'Partner One', status: 'active' }]
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: [{ id: 'org-1', partnerId: 'partner-1', name: 'Org One', status: 'active' }]
        })
      )
      .mockResolvedValueOnce(makeResponse({ data: [] }));

    await useOrgStore.getState().fetchPartners();
    await flushAsync();

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/organizations?partnerId=partner-1');
    expect(useOrgStore.getState().currentPartnerId).toBe('partner-1');
    expect(useOrgStore.getState().partners).toHaveLength(1);
  });

  it('fetchPartners adopting the first partner preserves an explicit All-orgs choice', async () => {
    // /settings/partner regression: pages that fetch partners must not hijack
    // the user's context. Adopting the first partner id used to go through
    // setPartner, whose reset + auto-select snapped scope to the first org.
    useOrgStore.setState({ currentOrgId: null, allOrgs: true });

    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeResponse({ data: [{ id: 'partner-1', name: 'Partner One', status: 'active' }] })
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: [{ id: 'org-1', partnerId: 'partner-1', name: 'Org One', status: 'active' }]
        })
      );

    await useOrgStore.getState().fetchPartners();
    await flushAsync();

    expect(useOrgStore.getState().currentPartnerId).toBe('partner-1');
    expect(useOrgStore.getState().currentOrgId).toBeNull();
    expect(useOrgStore.getState().allOrgs).toBe(true);
  });

  it('fetchPartners adopting the first partner preserves a concrete org selection', async () => {
    useOrgStore.setState({ currentOrgId: 'org-2', lastOrgId: 'org-2' });

    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeResponse({ data: [{ id: 'partner-1', name: 'Partner One', status: 'active' }] })
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: [
            { id: 'org-1', partnerId: 'partner-1', name: 'Org One', status: 'active' },
            { id: 'org-2', partnerId: 'partner-1', name: 'Org Two', status: 'active' }
          ]
        })
      );

    await useOrgStore.getState().fetchPartners();
    await flushAsync();

    expect(useOrgStore.getState().currentPartnerId).toBe('partner-1');
    expect(useOrgStore.getState().currentOrgId).toBe('org-2');
  });

  it('fetchSites populates the shared site cache for the selected org', async () => {
    useOrgStore.setState({ currentOrgId: 'org-1' });

    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({
        data: [
          {
            id: 'site-1',
            organizationId: 'org-1',
            name: 'HQ',
            status: 'active',
            deviceCount: 5
          }
        ]
      })
    );

    await useOrgStore.getState().fetchSites();

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/sites?organizationId=org-1');
    expect(useOrgStore.getState().sites.map((s) => s.id)).toEqual(['site-1']);
  });

  it('sets error when organization fetch fails', async () => {
    useOrgStore.setState({ currentPartnerId: 'partner-1' });
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ error: 'nope' }, false, 500));

    await useOrgStore.getState().fetchOrganizations();

    expect(useOrgStore.getState().error).toBe('Failed to fetch organizations');
    expect(useOrgStore.getState().isLoading).toBe(false);
  });

  it('marks organizationsLoaded only after a successful fetch (empty-partner is distinguishable from loading)', async () => {
    useOrgStore.setState({ currentPartnerId: 'partner-1' });
    expect(useOrgStore.getState().organizationsLoaded).toBe(false);

    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ data: [] }));
    await useOrgStore.getState().fetchOrganizations();

    // Zero orgs: nothing auto-selects, but the list HAS resolved.
    expect(useOrgStore.getState().organizationsLoaded).toBe(true);
    expect(useOrgStore.getState().currentOrgId).toBeNull();
    expect(useOrgStore.getState().allOrgs).toBe(false);
  });

  it('vanished cached org with nothing to auto-select resets to the unresolved shape (not All-orgs)', async () => {
    // A concrete org was selected, but the refetched list no longer contains it
    // and is otherwise empty — must clear WITHOUT flipping allOrgs, or the
    // persisted null would read as an explicit All-orgs choice.
    useOrgStore.setState({ currentPartnerId: 'partner-1', currentOrgId: 'org-gone', allOrgs: false });
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ data: [] }));

    await useOrgStore.getState().fetchOrganizations();

    expect(useOrgStore.getState().currentOrgId).toBeNull();
    expect(useOrgStore.getState().allOrgs).toBe(false);
  });

  it('selectAllOrgs / selectOrganization / resetSelection are explicit about intent', () => {
    useOrgStore.getState().selectAllOrgs();
    expect(useOrgStore.getState().allOrgs).toBe(true);
    expect(useOrgStore.getState().currentOrgId).toBeNull();

    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ data: [] }));
    useOrgStore.getState().selectOrganization('org-3');
    expect(useOrgStore.getState().currentOrgId).toBe('org-3');
    expect(useOrgStore.getState().allOrgs).toBe(false);
    expect(useOrgStore.getState().lastOrgId).toBe('org-3');

    useOrgStore.getState().resetSelection();
    expect(useOrgStore.getState().currentOrgId).toBeNull();
    expect(useOrgStore.getState().allOrgs).toBe(false);
  });

  it('rehydrate merge normalizes a contradictory persisted {currentOrgId + allOrgs:true}', () => {
    // Simulate stale/tampered localStorage from an older schema.
    localStorage.setItem(
      'breeze-org',
      JSON.stringify({ state: { currentOrgId: 'org-1', allOrgs: true, currentPartnerId: 'partner-1', lastOrgId: 'org-1' }, version: 0 })
    );
    useOrgStore.persist.rehydrate();

    // Concrete selection wins; the contradictory allOrgs is dropped.
    expect(useOrgStore.getState().currentOrgId).toBe('org-1');
    expect(useOrgStore.getState().allOrgs).toBe(false);
  });
});
