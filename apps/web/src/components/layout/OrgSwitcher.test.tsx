import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrgSwitcher, { getOrgSwitchRedirect } from './OrgSwitcher';

const setOrganizationMock = vi.fn();
const setSiteMock = vi.fn();
const fetchOrganizationsMock = vi.fn();
const fetchSitesMock = vi.fn();
// vi.mock factories are hoisted; declare with vi.hoisted so the mock
// factory below can close over the same reference.
const { waitForPendingRefreshMock } = vi.hoisted(() => ({
  waitForPendingRefreshMock: vi.fn().mockResolvedValue(undefined)
}));

let mockStoreState: {
  currentOrgId: string | null;
  currentSiteId: string | null;
  organizations: Array<{ id: string; partnerId: string; name: string; status: string; createdAt: string }>;
  sites: Array<{ id: string; orgId: string; name: string; deviceCount: number; createdAt: string }>;
  isLoading: boolean;
};

vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({
    ...mockStoreState,
    setOrganization: setOrganizationMock,
    setSite: setSiteMock,
    fetchOrganizations: fetchOrganizationsMock,
    fetchSites: fetchSitesMock
  })
}));

// Mock the auth store so the OrgSwitcher's #950 refresh-race guard
// (waitForPendingRefresh) resolves immediately in unit tests without
// pulling in the real zustand store + module-level state.
vi.mock('@/stores/auth', () => ({
  waitForPendingRefresh: waitForPendingRefreshMock
}));

describe('getOrgSwitchRedirect', () => {
  it('redirects /devices/:id to /devices', () => {
    expect(getOrgSwitchRedirect('/devices/abc123')).toBe('/devices');
    expect(getOrgSwitchRedirect('/devices/abc123/')).toBe('/devices');
  });

  it('does not redirect from the device list itself', () => {
    expect(getOrgSwitchRedirect('/devices')).toBeNull();
    expect(getOrgSwitchRedirect('/devices/')).toBeNull();
  });

  it('does not redirect sibling device routes that share the prefix', () => {
    expect(getOrgSwitchRedirect('/devices/compare')).toBeNull();
    expect(getOrgSwitchRedirect('/devices/groups')).toBeNull();
  });

  it('does not redirect unrelated routes', () => {
    expect(getOrgSwitchRedirect('/')).toBeNull();
    expect(getOrgSwitchRedirect('/alerts/abc123')).toBeNull();
    expect(getOrgSwitchRedirect('/scripts/abc123')).toBeNull();
    expect(getOrgSwitchRedirect('/settings/organizations/abc123')).toBeNull();
  });
});

describe('OrgSwitcher org change navigation', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    setOrganizationMock.mockReset();
    setSiteMock.mockReset();
    fetchOrganizationsMock.mockReset();
    fetchSitesMock.mockReset();
    waitForPendingRefreshMock.mockClear();

    mockStoreState = {
      currentOrgId: 'org-a',
      currentSiteId: null,
      organizations: [
        { id: 'org-a', partnerId: 'p1', name: 'Org A', status: 'active', createdAt: '2024-01-01' },
        { id: 'org-b', partnerId: 'p1', name: 'Org B', status: 'active', createdAt: '2024-01-01' }
      ],
      sites: [],
      isLoading: false
    };
  });

  function stubLocation(pathname: string) {
    const reloadMock = vi.fn();
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        pathname,
        reload: reloadMock,
        set href(value: string) {
          hrefSetter(value);
        },
        get href() {
          return `http://localhost${pathname}`;
        }
      }
    });
    return { reloadMock, hrefSetter };
  }

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation
    });
  });

  function openDropdownAndClickOrg(orgName: string) {
    // Toggle the trigger button (first button on the page) to open the dropdown,
    // then click the menu item that matches the org name.
    const triggerButton = screen.getAllByRole('button')[0];
    fireEvent.click(triggerButton);
    const orgButtons = screen
      .getAllByRole('button')
      .filter((b) => b !== triggerButton && b.textContent?.includes(orgName));
    if (orgButtons.length === 0) {
      throw new Error(`No menu item for ${orgName} found`);
    }
    fireEvent.click(orgButtons[0]);
  }

  it('redirects to /devices when switching orgs from a device-detail page', async () => {
    const { reloadMock, hrefSetter } = stubLocation('/devices/abc123');

    render(<OrgSwitcher />);

    openDropdownAndClickOrg('Org B');

    // setOrganization is called synchronously inside the click handler.
    expect(setOrganizationMock).toHaveBeenCalledWith('org-b');
    // The navigation step is gated behind await waitForPendingRefresh()
    // (#950 fix) so it lands on a later microtask. waitFor handles the
    // settle cycle.
    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('/devices'));
    expect(reloadMock).not.toHaveBeenCalled();
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('reloads in place when switching orgs from a non-detail page', async () => {
    const { reloadMock, hrefSetter } = stubLocation('/devices');

    render(<OrgSwitcher />);

    openDropdownAndClickOrg('Org B');

    expect(setOrganizationMock).toHaveBeenCalledWith('org-b');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(hrefSetter).not.toHaveBeenCalled();
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('does nothing when clicking the already-selected organization', () => {
    const { reloadMock, hrefSetter } = stubLocation('/devices/abc123');

    render(<OrgSwitcher />);

    openDropdownAndClickOrg('Org A');

    expect(setOrganizationMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
  });
});
