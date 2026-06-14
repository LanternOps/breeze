import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrgSwitcher, { getOrgSwitchRedirect } from './OrgSwitcher';

const {
  setOrganizationMock,
  setSiteMock,
  setOrgScopeMock,
  fetchOrganizationsMock,
  fetchSitesMock,
  waitForPendingRefreshMock,
  mockStoreRef,
} = vi.hoisted(() => ({
  setOrganizationMock: vi.fn(),
  setSiteMock: vi.fn(),
  setOrgScopeMock: vi.fn(),
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
  orgScope: 'current' | 'all';
  organizations: Array<{ id: string; partnerId: string; name: string; status: string; createdAt: string }>;
  sites: Array<{ id: string; orgId: string; name: string; deviceCount: number; createdAt: string }>;
  isLoading: boolean;
};

vi.mock('@/stores/orgStore', () => {
  const buildStoreSnapshot = () => ({
    ...mockStoreRef.current,
    setOrganization: setOrganizationMock,
    setSite: setSiteMock,
    setOrgScope: setOrgScopeMock,
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
    setOrgScopeMock.mockReset();
    fetchOrganizationsMock.mockReset();
    fetchSitesMock.mockReset();
    waitForPendingRefreshMock.mockClear();
    waitForPendingRefreshMock.mockResolvedValue(undefined);

    mockStoreState = {
      currentOrgId: 'org-a',
      currentSiteId: null,
      orgScope: 'current',
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

  function openDropdownAndClickOrg(orgName: string) {
    // The OrgScopePill renders two buttons BEFORE the org-picker trigger when
    // multiple orgs are accessible, so target the trigger explicitly by
    // data-testid rather than relying on DOM order.
    const triggerButton = screen.getByTestId('org-switcher-trigger');
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

  // #989: flipping the scope pill must refresh every list page, not just the
  // ones that happen to key on orgScope. The pill reloads after the flip,
  // mirroring the org-switch path.
  it('reloads after waitForPendingRefresh when flipping the scope pill to All orgs', async () => {
    const { reloadMock } = stubLocation('/devices');

    render(<OrgSwitcher />);

    fireEvent.click(screen.getByTestId('org-scope-all'));

    expect(setOrgScopeMock).toHaveBeenCalledWith('all');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('does nothing when re-clicking the already-active scope', () => {
    const { reloadMock } = stubLocation('/devices'); // store starts at orgScope 'current'

    render(<OrgSwitcher />);

    fireEvent.click(screen.getByTestId('org-scope-current'));

    expect(setOrgScopeMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });
});

// #1319: when a site is the active scope, opening the picker should land the
// user on their current context — the ancestor org pre-expanded and the
// selected site row visible/highlighted — instead of a flat list of collapsed
// orgs.
describe('OrgSwitcher pre-expand to selected site (#1319)', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    setOrganizationMock.mockReset();
    setSiteMock.mockReset();
    setOrgScopeMock.mockReset();
    fetchOrganizationsMock.mockReset();
    fetchSitesMock.mockReset();
    waitForPendingRefreshMock.mockClear();
    waitForPendingRefreshMock.mockResolvedValue(undefined);

    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, pathname: '/devices', reload: vi.fn() }
    });

    mockStoreState = {
      currentOrgId: 'org-a',
      currentSiteId: 'site-a1',
      orgScope: 'current',
      organizations: [
        { id: 'org-a', partnerId: 'p1', name: 'Org A', status: 'active', createdAt: '2024-01-01' },
        { id: 'org-b', partnerId: 'p1', name: 'Org B', status: 'active', createdAt: '2024-01-01' }
      ],
      sites: [
        { id: 'site-a1', orgId: 'org-a', name: 'HQ Site', deviceCount: 12, createdAt: '2024-01-01' },
        { id: 'site-a2', orgId: 'org-a', name: 'Branch Site', deviceCount: 3, createdAt: '2024-01-01' }
      ],
      isLoading: false
    };
    mockStoreRef.current = mockStoreState;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation
    });
  });

  function openDropdown() {
    fireEvent.click(screen.getByTestId('org-switcher-trigger'));
  }

  it('auto-expands the ancestor org so the selected site is visible on open without a manual click', () => {
    render(<OrgSwitcher />);

    openDropdown();

    // The selected site's row (and its sibling) are visible immediately — the
    // user did NOT have to click the org row to expand it.
    expect(screen.getByText('HQ Site')).toBeInTheDocument();
    expect(screen.getByText('Branch Site')).toBeInTheDocument();
    // The "All Sites" affordance only renders inside an expanded org, so its
    // presence confirms the submenu mounted.
    expect(screen.getByText('All Sites')).toBeInTheDocument();
  });

  it('does not throw even though jsdom stubs scrollIntoView (selected row scrolled into view)', () => {
    // jsdom does not implement scrollIntoView; the component guards the call.
    // Opening must not throw regardless of whether the stub exists.
    expect(() => {
      render(<OrgSwitcher />);
      openDropdown();
    }).not.toThrow();
  });

  it('does not auto-expand any org in All-orgs scope', () => {
    mockStoreState.orgScope = 'all';
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    openDropdown();

    // No submenu should be visible: sites stay hidden and there is no
    // "All Sites" row until the user manually expands an org.
    expect(screen.queryByText('HQ Site')).not.toBeInTheDocument();
    expect(screen.queryByText('All Sites')).not.toBeInTheDocument();
  });

  it('leaves orgs collapsed when only an org (no site) is selected', () => {
    mockStoreState.currentSiteId = null;
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    openDropdown();

    // Org selected but no site → submenu stays collapsed.
    expect(screen.queryByText('HQ Site')).not.toBeInTheDocument();
    expect(screen.queryByText('All Sites')).not.toBeInTheDocument();
  });

  it('re-seeds expansion on each open so a manual collapse does not persist across opens', () => {
    render(<OrgSwitcher />);

    // First open: auto-expanded.
    openDropdown();
    expect(screen.getByText('HQ Site')).toBeInTheDocument();

    // Manually collapse Org A by clicking its row, then close the dropdown.
    const orgARow = screen
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('data-testid') !== 'org-switcher-trigger' &&
          b.textContent?.includes('Org A')
      )!;
    fireEvent.click(orgARow);
    expect(screen.queryByText('HQ Site')).not.toBeInTheDocument();

    // Re-open — should re-seed and expand again rather than respect the manual
    // collapse from the prior session.
    openDropdown(); // toggle closed
    openDropdown(); // toggle open again
    expect(screen.getByText('HQ Site')).toBeInTheDocument();
  });
});
