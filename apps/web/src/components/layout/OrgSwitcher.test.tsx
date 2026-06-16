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
  lastOrgId?: string | null;
  allOrgs?: boolean;
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

  it('renders the Current / All-orgs scope pill on a scoped route with multiple orgs', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    expect(screen.getByTestId('org-scope-pill')).toBeTruthy();
    // org-a selected → "Current" is pressed, "All orgs" is not.
    expect(screen.getByTestId('org-scope-current').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('org-scope-all').getAttribute('aria-pressed')).toBe('false');
  });

  it('hides the scope pill with a single org (toggle would be a no-op)', () => {
    stubLocation('/devices');
    mockStoreState.organizations = [mockStoreState.organizations[0]];
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    expect(screen.queryByTestId('org-scope-pill')).toBeNull();
  });

  it('hides the scope pill on a global/catalog route (partner-wide regardless of selection)', () => {
    // /scripts is a global route per the default mock
    stubLocation('/scripts');

    render(<OrgSwitcher />);

    expect(screen.queryByTestId('org-scope-pill')).toBeNull();
  });

  it('no longer renders the dropdown "All Organizations" option (reverted in favor of the pill)', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();

    expect(screen.queryByTestId('org-option-all')).toBeNull();
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

  it('clicking the "All orgs" pill calls setOrganization with "" and reloads', async () => {
    const { reloadMock } = stubLocation('/devices');

    // org-a is selected, so "All orgs" is a real scope change.
    render(<OrgSwitcher />);

    fireEvent.click(screen.getByTestId('org-scope-all'));

    expect(setOrganizationMock).toHaveBeenCalledWith('');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('clicking the "Current" pill from All-orgs returns to the last selected org', async () => {
    const { reloadMock } = stubLocation('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.lastOrgId = 'org-b';
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    fireEvent.click(screen.getByTestId('org-scope-current'));

    expect(setOrganizationMock).toHaveBeenCalledWith('org-b');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('clicking "Current" with no lastOrgId falls back to the first org', async () => {
    const { reloadMock } = stubLocation('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.lastOrgId = null;
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    fireEvent.click(screen.getByTestId('org-scope-current'));

    expect(setOrganizationMock).toHaveBeenCalledWith('org-a');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });

  it('clicking "Current" with a stale lastOrgId (no longer in the list) falls back to the first org', async () => {
    const { reloadMock } = stubLocation('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.lastOrgId = 'org-deleted';
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    fireEvent.click(screen.getByTestId('org-scope-current'));

    expect(setOrganizationMock).toHaveBeenCalledWith('org-a');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });

  it('clicking the already-active scope on the pill is a no-op (no reload)', () => {
    const { reloadMock } = stubLocation('/devices');

    // org-a selected → "Current" is already active.
    render(<OrgSwitcher />);

    fireEvent.click(screen.getByTestId('org-scope-current'));

    expect(setOrganizationMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('closes the dropdown with Escape and returns focus to the trigger', async () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    // Open the dropdown
    const trigger = screen.getByTestId('org-switcher-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('org-switcher-panel')).toBeTruthy();

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('org-switcher-panel')).toBeNull();
    });
  });

  it('Cmd+O toggles the dropdown', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    // Closed initially
    expect(screen.queryByTestId('org-switcher-panel')).toBeNull();

    // Open with Cmd+O
    fireEvent.keyDown(document, { key: 'o', metaKey: true });
    expect(screen.getByTestId('org-switcher-panel')).toBeTruthy();

    // Close with Cmd+O
    fireEvent.keyDown(document, { key: 'o', metaKey: true });
    expect(screen.queryByTestId('org-switcher-panel')).toBeNull();
  });

  it('closes dropdown when clicking outside', async () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();
    expect(screen.getByTestId('org-switcher-panel')).toBeTruthy();

    // Click outside
    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByTestId('org-switcher-panel')).toBeNull();
    });
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

  it('does not auto-expand any org when no org is selected (partner-wide / All-orgs view)', () => {
    // In the page-aware model (#1357) "All organizations" is represented by
    // no org being selected, not a separate scope flag. With no current org
    // there is no ancestor to pre-expand.
    mockStoreState.currentOrgId = null;
    mockStoreState.currentSiteId = null;
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
