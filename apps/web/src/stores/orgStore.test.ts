import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn()
}));

import { fetchWithAuth } from './auth';
import { getCurrentOrganization, getCurrentSite, useOrgStore } from './orgStore';

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
      currentSiteId: null,
      partners: [],
      organizations: [],
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

  it('fetchSites populates helper-selected site', async () => {
    useOrgStore.setState({ currentOrgId: 'org-1', currentSiteId: 'site-1' });

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
    expect(getCurrentSite()?.id).toBe('site-1');
  });

  it('sets error when organization fetch fails', async () => {
    useOrgStore.setState({ currentPartnerId: 'partner-1' });
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ error: 'nope' }, false, 500));

    await useOrgStore.getState().fetchOrganizations();

    expect(useOrgStore.getState().error).toBe('Failed to fetch organizations');
    expect(useOrgStore.getState().isLoading).toBe(false);
  });
});
