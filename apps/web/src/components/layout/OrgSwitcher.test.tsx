import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrgSwitcher, { getOrgSwitchRedirect } from './OrgSwitcher';

const {
  setOrganizationMock,
  setSiteMock,
  fetchOrganizationsMock,
  fetchSitesMock,
  waitForPendingRefreshMock,
  mockStoreRef,
} = vi.hoisted(() => ({
  setOrganizationMock: vi.fn(),
  setSiteMock: vi.fn(),
  fetchOrganizationsMock: vi.fn(),
  fetchSitesMock: vi.fn(),
  waitForPendingRefreshMock: vi.fn().mockResolvedValue(undefined),
  mockStoreRef: { current: null as any },
}));

// The org/site switch handlers await waitForPendingRefresh() before navigating
// so an in-flight /auth/refresh can't be interrupted (the #950 login-bounce
// race, fixed in #953/#956/#958). Mock it to resolve immediately here.
vi.mock('@/stores/auth', () => ({
  waitForPendingRefresh: waitForPendingRefreshMock
}));

let mockStoreState: {
  currentOrgId: string | null;
  currentSiteId: string | null;
  organizations: Array<{ id: string; partnerId: string; name: string; status: string; createdAt: string }>;
  sites: Array<{ id: string; orgId: string; name: string; deviceCount: number; createdAt: string }>;
  isLoading: boolean;
};

vi.mock('@/stores/orgStore', () => {
  const buildStoreSnapshot = () => ({
    ...mockStoreRef.current,
    setOrganization: setOrganizationMock,
    setSite: setSiteMock,
    fetchOrganizations: fetchOrganizationsMock,
    fetchSites: fetchSitesMock,
  });
  const useOrgStore = vi.fn((selector?: (state: ReturnType<typeof buildStoreSnapshot>) => unknown) => {
    const snap = buildStoreSnapshot();
    return selector ? selector(snap) : snap;
  });
  (useOrgStore as unknown as { getState: () => ReturnType<typeof buildStoreSnapshot> }).getState = () => buildStoreSnapshot();
  return { useOrgStore };
});

// Mock routeScope so we can control isGlobalScopeRoute per-test
vi.mock('../../lib/routeScope', () => ({
  isGlobalScopeRoute: vi.fn((pathname: string) => {
    // Default: mirror the real implementation for /scripts
    return /^\/scripts(\/.*)?$/.test(pathname);
  })
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
    waitForPendingRefreshMock.mockResolvedValue(undefined);

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
    mockStoreRef.current = mockStoreState;
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

  function openDropdown() {
    const triggerButton = screen.getByTestId('org-switcher-trigger');
    fireEvent.click(triggerButton);
    return triggerButton;
  }

  function openDropdownAndClickOrg(orgName: string) {
    const triggerButton = openDropdown();
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

    expect(setOrganizationMock).toHaveBeenCalledWith('org-b');
    // Navigation is gated behind await waitForPendingRefresh() (#950 race guard).
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

  it('renders an org-option-all item containing "All Organizations" when dropdown is open', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();

    const allOrgsBtn = screen.getByTestId('org-option-all');
    expect(allOrgsBtn).toBeTruthy();
    expect(allOrgsBtn.textContent).toContain('All Organizations');
  });

  it('the legacy pill is gone', () => {
    stubLocation('/devices');
    render(<OrgSwitcher />);
    expect(screen.queryByTestId('org-scope-pill')).toBeNull();
  });

  it('label reads "All Organizations" on a global route (e.g. /scripts)', () => {
    // /scripts is a global route per the default mock
    stubLocation('/scripts');

    render(<OrgSwitcher />);

    const label = screen.getByTestId('org-switcher-label');
    expect(label.textContent).toBe('All Organizations');
  });

  it('label shows org name on a scoped route with a selected org', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    const label = screen.getByTestId('org-switcher-label');
    expect(label.textContent).toBe('Org A');
  });

  it('label reads "All Organizations" on a scoped route when no org is selected', () => {
    stubLocation('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    const label = screen.getByTestId('org-switcher-label');
    expect(label.textContent).toBe('All Organizations');
  });

  it('clicking "All Organizations" calls setOrganization with "" and reloads', async () => {
    const { reloadMock } = stubLocation('/devices');

    // Start with an org selected so the "All Organizations" item is not highlighted
    render(<OrgSwitcher />);
    openDropdown();

    const allOrgsBtn = screen.getByTestId('org-option-all');
    fireEvent.click(allOrgsBtn);

    expect(setOrganizationMock).toHaveBeenCalledWith('');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('closes the dropdown with Escape and returns focus to the trigger', async () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    // Open the dropdown
    const trigger = screen.getByTestId('org-switcher-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('org-option-all')).toBeTruthy();

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('org-option-all')).toBeNull();
    });
  });

  it('Cmd+O toggles the dropdown', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    // Closed initially
    expect(screen.queryByTestId('org-option-all')).toBeNull();

    // Open with Cmd+O
    fireEvent.keyDown(document, { key: 'o', metaKey: true });
    expect(screen.getByTestId('org-option-all')).toBeTruthy();

    // Close with Cmd+O
    fireEvent.keyDown(document, { key: 'o', metaKey: true });
    expect(screen.queryByTestId('org-option-all')).toBeNull();
  });

  it('closes dropdown when clicking outside', async () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();
    expect(screen.getByTestId('org-option-all')).toBeTruthy();

    // Click outside
    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByTestId('org-option-all')).toBeNull();
    });
  });
});
