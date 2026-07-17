import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrgSwitcher, { getOrgSwitchRedirect } from './OrgSwitcher';

const {
  selectOrganizationMock,
  selectAllOrgsMock,
  fetchOrganizationsMock,
  waitForPendingRefreshMock,
  mockStoreRef,
} = vi.hoisted(() => ({
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

let mockStoreState: {
  currentOrgId: string | null;
  allOrgs: boolean;
  lastOrgId?: string | null;
  organizations: Array<{ id: string; partnerId: string; name: string; status: string; createdAt: string }>;
  isLoading: boolean;
};

vi.mock('@/stores/orgStore', () => {
  const buildStoreSnapshot = () => ({
    ...mockStoreRef.current,
    selectOrganization: selectOrganizationMock,
    selectAllOrgs: selectAllOrgsMock,
    fetchOrganizations: fetchOrganizationsMock,
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

    expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
    // Navigation is gated behind await waitForPendingRefresh() (#950 race guard).
    await waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('/devices'));
    expect(reloadMock).not.toHaveBeenCalled();
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('reloads in place when switching orgs from a non-detail page', async () => {
    const { reloadMock, hrefSetter } = stubLocation('/devices');

    render(<OrgSwitcher />);

    openDropdownAndClickOrg('Org B');

    expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(hrefSetter).not.toHaveBeenCalled();
    expect(waitForPendingRefreshMock).toHaveBeenCalled();
  });

  it('does nothing when clicking the already-selected organization', () => {
    const { reloadMock, hrefSetter } = stubLocation('/devices/abc123');

    render(<OrgSwitcher />);

    openDropdownAndClickOrg('Org A');

    expect(selectOrganizationMock).not.toHaveBeenCalled();
    expect(selectAllOrgsMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
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

  it('clicking the fleet row clears the selection and reloads', async () => {
    const { reloadMock } = stubLocation('/devices');

    render(<OrgSwitcher />);
    openDropdown();
    fireEvent.click(screen.getByTestId('org-option-all'));

    expect(selectAllOrgsMock).toHaveBeenCalled();
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
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

    expect(screen.getByText('Org H')).toBeInTheDocument();
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
});
