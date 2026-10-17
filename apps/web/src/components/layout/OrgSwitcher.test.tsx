import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '../../lib/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrgSwitcher, { getOrgSwitchRedirect } from './OrgSwitcher';

const {
  selectOrganizationMock,
  selectAllOrgsMock,
  fetchOrganizationsMock,
  waitForPendingRefreshMock,
  navigateToMock,
  recordRecentOrgMock,
  summaryLookupMock,
  showToastMock,
  mockStoreRef,
} = vi.hoisted(() => ({
  navigateToMock: vi.fn().mockResolvedValue('soft'),
  recordRecentOrgMock: vi.fn(),
  summaryLookupMock: vi.fn(),
  showToastMock: vi.fn(),
  selectOrganizationMock: vi.fn(),
  selectAllOrgsMock: vi.fn(),
  fetchOrganizationsMock: vi.fn(),
  waitForPendingRefreshMock: vi.fn().mockResolvedValue(undefined),
  mockStoreRef: { current: null as any },
}));

// The context-switch handler awaits waitForPendingRefresh() before navigating
// so an in-flight /auth/refresh can't be interrupted (the #950 login-bounce
// race, fixed in #953/#956/#958). Mock it to resolve immediately here.
vi.mock('@/stores/auth', () => ({
  waitForPendingRefresh: waitForPendingRefreshMock
}));

// The switch is a soft (view-transition) navigation now, never a reload.
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));
vi.mock('@/components/shared/Toast', () => ({ showToast: showToastMock }));
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  usePermissions: () => ({ permissions: [{ resource: '*', action: '*' }], can: () => true }),
}));
vi.mock('./useOrgSummaryCache', () => ({ useOrgSummaryCache: summaryLookupMock }));

let mockStoreState: {
  currentOrgId: string | null;
  allOrgs: boolean;
  lastOrgId?: string | null;
  organizations: Array<{ id: string; partnerId: string; name: string; status: string; createdAt: string }>;
  isLoading: boolean;
  recentOrgIds: string[];
  serviceManagementMode: string;
};

vi.mock('@/stores/orgStore', () => {
  const buildStoreSnapshot = () => ({
    ...mockStoreRef.current,
    selectOrganization: selectOrganizationMock,
    selectAllOrgs: selectAllOrgsMock,
    fetchOrganizations: fetchOrganizationsMock,
    recordRecentOrg: recordRecentOrgMock,
  });
  const useOrgStore = vi.fn((selector?: (state: ReturnType<typeof buildStoreSnapshot>) => unknown) => {
    const snap = buildStoreSnapshot();
    return selector ? selector(snap) : snap;
  });
  (useOrgStore as unknown as { getState: () => ReturnType<typeof buildStoreSnapshot> }).getState = () => buildStoreSnapshot();
  return { useOrgStore };
});

function makeOrgs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `org-${String.fromCharCode(97 + i)}`,
    partnerId: 'p1',
    name: `Org ${String.fromCharCode(65 + i)}`,
    status: 'active',
    createdAt: '2024-01-01',
  }));
}

const originalMatchMedia = window.matchMedia;
function stubMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

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

describe('OrgSwitcher (unified control)', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    selectOrganizationMock.mockReset();
    selectAllOrgsMock.mockReset();
    fetchOrganizationsMock.mockReset();
    waitForPendingRefreshMock.mockClear();
    waitForPendingRefreshMock.mockResolvedValue(undefined);

    mockStoreState = {
      currentOrgId: 'org-a',
      allOrgs: false,
      organizations: makeOrgs(2),
      isLoading: false,
      recentOrgIds: [],
      serviceManagementMode: 'native'
    };
    recordRecentOrgMock.mockReset();
    summaryLookupMock.mockReset().mockReturnValue({ summary: undefined, status: 'idle' });
    showToastMock.mockReset();
    stubMatchMedia(true);
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
    window.matchMedia = originalMatchMedia;
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

  // #9027: a name click from a record page switches the working org and keeps
  // the user on the record instead of bouncing them to the (possibly empty)
  // list. Sub-item destinations keep their explicit targets.
  it.each(['/devices/abc123', '/organizations/org-z', '/tickets/t-1'])(
    'stays on the record when switching orgs by name from %s',
    async (path) => {
      const { reloadMock, hrefSetter } = stubLocation(path);

      render(<OrgSwitcher />);

      openDropdownAndClickOrg('Org B');

      expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
      // Navigation is gated behind await waitForPendingRefresh() (#950 race guard).
      await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith(path, { replace: false }));
      expect(navigateToMock).not.toHaveBeenCalledWith('/devices', expect.anything());
      expect(reloadMock).not.toHaveBeenCalled();
      expect(hrefSetter).not.toHaveBeenCalled();
      expect(waitForPendingRefreshMock).toHaveBeenCalled();
    },
  );

  it('soft-navigates in place (no reload) when switching orgs from a non-detail page', async () => {
    const { reloadMock, hrefSetter } = stubLocation('/devices');

    render(<OrgSwitcher />);

    openDropdownAndClickOrg('Org B');

    expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/devices', { replace: true }));
    expect(reloadMock).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('clears the switching spinner once the soft navigation settles (the island persists across it)', async () => {
    stubLocation('/devices');
    let settle: () => void = () => {};
    navigateToMock.mockImplementationOnce(() => new Promise<'soft'>((resolve) => { settle = () => resolve('soft'); }));

    render(<OrgSwitcher />);
    openDropdownAndClickOrg('Org B');

    const trigger = screen.getByTestId('org-switcher-trigger');
    await waitFor(() => expect(trigger).toHaveProperty('disabled', true));
    settle();
    await waitFor(() => expect(trigger).toHaveProperty('disabled', false));
  });

  it('does nothing when clicking the already-selected organization', () => {
    const { reloadMock, hrefSetter } = stubLocation('/devices/abc123');

    render(<OrgSwitcher />);

    openDropdownAndClickOrg('Org A');

    expect(selectOrganizationMock).not.toHaveBeenCalled();
    expect(selectAllOrgsMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
    // #9027: no stay-on-record navigation either — nothing changed.
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('renders a pinned "All organizations" fleet row with >1 org', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();

    const allRow = screen.getByTestId('org-option-all');
    expect(allRow.textContent).toContain('All organizations');
  });

  it('hides the fleet row with a single org (fleet view would be a no-op)', () => {
    stubLocation('/devices');
    mockStoreState.organizations = makeOrgs(1);
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);
    openDropdown();

    expect(screen.queryByTestId('org-option-all')).toBeNull();
  });

  it('no longer renders the legacy Current/All-orgs scope pill', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    expect(screen.queryByTestId('org-scope-pill')).toBeNull();
    expect(screen.queryByTestId('org-scope-current')).toBeNull();
    expect(screen.queryByTestId('org-scope-all')).toBeNull();
  });

  it('clicking the fleet row clears the selection and soft-navigates', async () => {
    const { reloadMock } = stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();
    fireEvent.click(screen.getByTestId('org-option-all'));

    expect(selectAllOrgsMock).toHaveBeenCalled();
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/devices', { replace: true }));
    expect(reloadMock).not.toHaveBeenCalled();
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('clicking the fleet row while already in fleet view is a no-op', () => {
    const { reloadMock } = stubLocation('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.allOrgs = true;
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);
    openDropdown();
    fireEvent.click(screen.getByTestId('org-option-all'));

    expect(selectAllOrgsMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('label + data-scope reflect fleet view (explicit allOrgs)', () => {
    stubLocation('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.allOrgs = true;
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    expect(screen.getByTestId('org-switcher-label').textContent).toBe('All organizations');
    expect(screen.getByTestId('org-switcher-trigger').getAttribute('data-scope')).toBe('all');
  });

  it('label shows the org name and data-scope=org when one is selected', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    expect(screen.getByTestId('org-switcher-label').textContent).toBe('Org A');
    expect(screen.getByTestId('org-switcher-trigger').getAttribute('data-scope')).toBe('org');
  });

  it('keeps the org name in the mobile top bar, truncated rather than hidden (#9028)', () => {
    stubLocation('/devices');
    render(<OrgSwitcher />);
    const label = screen.getByTestId('org-switcher-label');
    expect(label.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(label.className).toContain('truncate');
  });

  it('label shows the selection placeholder on a transient null (not fleet view)', () => {
    stubLocation('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.allOrgs = false;
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);

    expect(screen.getByTestId('org-switcher-label').textContent).toBe('Select organization');
  });

  it('keeps showing the user context on a catalog route (two-layer model: the page scope line explains the page)', () => {
    stubLocation('/scripts');

    render(<OrgSwitcher />);

    expect(screen.getByTestId('org-switcher-label').textContent).toBe('Org A');
    expect(screen.getByTestId('org-switcher-trigger')).not.toBeDisabled();
  });

  it('shows a search input for long org lists and filters by name', () => {
    stubLocation('/devices');
    mockStoreState.organizations = makeOrgs(8);
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);
    openDropdown();

    const search = screen.getByTestId('org-switcher-search');
    fireEvent.change(search, { target: { value: 'Org H' } });

    // Scoped to the row: the pane now repeats the highlighted org's name.
    expect(within(screen.getByTestId('org-option-org-h')).getByText('Org H')).toBeInTheDocument();
    expect(screen.queryByText('Org B')).not.toBeInTheDocument();
    // The fleet row stays pinned regardless of the filter.
    expect(screen.getByTestId('org-option-all')).toBeInTheDocument();
  });

  it('shows an empty-filter message when nothing matches', () => {
    stubLocation('/devices');
    mockStoreState.organizations = makeOrgs(8);
    mockStoreRef.current = mockStoreState;

    render(<OrgSwitcher />);
    openDropdown();

    fireEvent.change(screen.getByTestId('org-switcher-search'), { target: { value: 'zzz' } });

    expect(screen.getByText('No organizations match')).toBeInTheDocument();
  });

  it('hides the search input for short org lists', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();

    expect(screen.queryByTestId('org-switcher-search')).toBeNull();
  });

  it('closes the dropdown with Escape and returns focus to the trigger', async () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    const trigger = screen.getByTestId('org-switcher-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('org-switcher-panel')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('org-switcher-panel')).toBeNull();
    });
  });

  it('Cmd+O toggles the dropdown', () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);

    expect(screen.queryByTestId('org-switcher-panel')).toBeNull();

    fireEvent.keyDown(document, { key: 'o', metaKey: true });
    expect(screen.getByTestId('org-switcher-panel')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'o', metaKey: true });
    expect(screen.queryByTestId('org-switcher-panel')).toBeNull();
  });

  it('closes dropdown when clicking outside', async () => {
    stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();
    expect(screen.getByTestId('org-switcher-panel')).toBeTruthy();

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByTestId('org-switcher-panel')).toBeNull();
    });
  });
  it('rows carry a status dot, not the badge', () => {
    stubLocation('/devices');
    mockStoreState.organizations[1].status = 'trial';
    render(<OrgSwitcher />);
    openDropdown();
    const row = screen.getByTestId('org-option-org-b');
    expect(within(row).getByTestId('org-status-dot').getAttribute('data-status')).toBe('trial');
    expect(within(row).queryByText('Trial')).toBeNull();
    expect(within(screen.getByTestId('org-option-org-a')).queryByTestId('org-status-dot')).toBeNull();
  });
  describe('Customer › Page columns (UI flow W02)', () => {
    it('opens with the current org highlighted and the pane showing it', () => {
      stubLocation('/devices');
      render(<OrgSwitcher />);
      openDropdown();
      expect(screen.getByTestId('org-option-org-a').getAttribute('data-highlighted')).toBe('true');
      expect(within(screen.getByTestId('org-switcher-pane')).getByText('Org A')).toBeTruthy();
      expect(screen.getByTestId('org-switcher-hint')).toBeTruthy();
      expect(summaryLookupMock).toHaveBeenLastCalledWith('org-a', true);
    });

    it('hovering a row moves the highlight and the pane follows', () => {
      stubLocation('/devices');
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.mouseEnter(screen.getByTestId('org-option-org-b'));
      expect(within(screen.getByTestId('org-switcher-pane')).getByText('Org B')).toBeTruthy();
      expect(summaryLookupMock).toHaveBeenLastCalledWith('org-b', true);
    });

    it('Billing destination switches to the highlighted org and lands on its billing tab (no redirect bounce)', async () => {
      stubLocation('/devices/abc123');
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.mouseEnter(screen.getByTestId('org-option-org-b'));
      fireEvent.click(screen.getByTestId('org-switcher-dest-billing'));

      expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
      expect(recordRecentOrgMock).toHaveBeenCalledWith('org-b');
      await waitFor(() =>
        expect(navigateToMock).toHaveBeenCalledWith('/organizations/org-b#billing', { replace: false }),
      );
      expect(screen.queryByTestId('org-switcher-panel')).toBeNull();
    });

    it("Devices destination calls applyOrgSwitch with '/devices'", async () => {
      stubLocation('/organizations/org-a');
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.mouseEnter(screen.getByTestId('org-option-org-b'));
      fireEvent.click(screen.getByTestId('org-switcher-dest-devices'));
      expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
      await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/devices', { replace: false }));
    });

    it('a destination for the current org is a plain navigation (no switch, no toast)', async () => {
      stubLocation('/devices');
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.click(screen.getByTestId('org-switcher-dest-sites'));
      await waitFor(() => expect(navigateToMock).toHaveBeenCalled());
      expect(navigateToMock.mock.calls[0][0]).toBe('/organizations/org-a#sites');
      expect(selectOrganizationMock).not.toHaveBeenCalled();
      expect(recordRecentOrgMock).not.toHaveBeenCalled();
      expect(showToastMock).not.toHaveBeenCalled();
    });

    it("a hash-only destination on the org's own record page sets the hash (the router does not fire hashchange)", async () => {
      stubLocation('/organizations/org-a');
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.click(screen.getByTestId('org-switcher-dest-sites'));
      // The stubbed location is a plain object, so the raw assigned value shows.
      await waitFor(() => expect(window.location.hash).toBe('sites'));
      expect(navigateToMock).not.toHaveBeenCalled();
      expect(selectOrganizationMock).not.toHaveBeenCalled();
      expect(showToastMock).not.toHaveBeenCalled();
    });

    it('keyboard: ArrowDown moves the highlight, ArrowRight enters the pane, ArrowLeft returns, activation navigates', async () => {
      stubLocation('/devices');
      render(<OrgSwitcher />);
      openDropdown();
      screen.getByTestId('org-option-org-a').focus();

      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByTestId('org-option-org-b'));
      expect(within(screen.getByTestId('org-switcher-pane')).getByText('Org B')).toBeTruthy();

      fireEvent.keyDown(document, { key: 'ArrowRight' });
      expect(document.activeElement).toBe(screen.getByTestId('org-switcher-dest-overview'));
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByTestId('org-switcher-dest-devices'));
      fireEvent.keyDown(document, { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(screen.getByTestId('org-option-org-b'));

      fireEvent.keyDown(document, { key: 'ArrowRight' });
      fireEvent.click(document.activeElement!);
      await waitFor(() =>
        expect(navigateToMock).toHaveBeenCalledWith('/organizations/org-b', { replace: false }),
      );
    });

    it('the list is one tab stop: only the highlighted row has tabIndex 0', () => {
      stubLocation('/devices');
      render(<OrgSwitcher />);
      openDropdown();
      expect(screen.getByTestId('org-option-org-a').tabIndex).toBe(0);
      expect(screen.getByTestId('org-option-org-b').tabIndex).toBe(-1);
      fireEvent.mouseEnter(screen.getByTestId('org-option-org-b'));
      expect(screen.getByTestId('org-option-org-a').tabIndex).toBe(-1);
      expect(screen.getByTestId('org-option-org-b').tabIndex).toBe(0);
    });

    it('Recent lists the last switched-to orgs newest first, without the current org', () => {
      stubLocation('/devices');
      mockStoreState.organizations = makeOrgs(5);
      mockStoreState.recentOrgIds = ['org-a', 'org-c', 'org-b'];
      render(<OrgSwitcher />);
      openDropdown();
      const recent = within(screen.getByTestId('org-switcher-recent'));
      expect(recent.getAllByRole('button').map((b) => b.textContent)).toEqual(['Org C', 'Org B']);
      expect(screen.queryByTestId('org-recent-org-a')).toBeNull();
    });

    it('an org listed in Recent and in the main list is highlighted once (main row only)', () => {
      stubLocation('/devices');
      mockStoreState.recentOrgIds = ['org-b'];
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.mouseEnter(screen.getByTestId('org-recent-org-b'));
      expect(document.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
      expect(screen.getByTestId('org-option-org-b').getAttribute('data-highlighted')).toBe('true');
      expect(screen.getByTestId('org-recent-org-b').getAttribute('data-highlighted')).toBeNull();
    });

    it('Recent skips ids no longer in the list and hides while searching or empty', () => {
      stubLocation('/devices');
      mockStoreState.recentOrgIds = ['org-zzz', 'org-b'];
      const { unmount } = render(<OrgSwitcher />);
      openDropdown();
      const recent = within(screen.getByTestId('org-switcher-recent'));
      expect(recent.getAllByRole('button')).toHaveLength(1);
      expect(screen.getByTestId('org-recent-org-b')).toBeTruthy();
      unmount();

      mockStoreState.organizations = makeOrgs(8);
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.change(screen.getByTestId('org-switcher-search'), { target: { value: 'Org H' } });
      expect(screen.queryByTestId('org-switcher-recent')).toBeNull();
    });

    it('Recent is absent when there is nothing recent', () => {
      stubLocation('/devices');
      render(<OrgSwitcher />);
      openDropdown();
      expect(screen.queryByTestId('org-switcher-recent')).toBeNull();
    });

    it('a search that hides the highlighted org moves the highlight to the first match', () => {
      stubLocation('/devices');
      mockStoreState.organizations = makeOrgs(8);
      render(<OrgSwitcher />);
      openDropdown();
      fireEvent.change(screen.getByTestId('org-switcher-search'), { target: { value: 'Org H' } });
      expect(screen.getByTestId('org-option-org-h').getAttribute('data-highlighted')).toBe('true');
      expect(within(screen.getByTestId('org-switcher-pane')).getByText('Org H')).toBeTruthy();
    });

    it('narrow viewport renders a single column: no pane, no hint, rows still switch', async () => {
      stubLocation('/devices');
      stubMatchMedia(false);
      render(<OrgSwitcher />);
      openDropdownAndClickOrg('Org B');
      expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
      await waitFor(() => expect(navigateToMock).toHaveBeenCalled());
      expect(screen.queryByTestId('org-switcher-pane')).toBeNull();
      expect(screen.queryByTestId('org-switcher-hint')).toBeNull();
      expect(summaryLookupMock).toHaveBeenCalledWith(null, true);
    });
  });
});
