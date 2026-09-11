import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { navigateToMock, showToastMock, selectOrganizationMock, selectAllOrgsMock } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  showToastMock: vi.fn(),
  selectOrganizationMock: vi.fn(),
  selectAllOrgsMock: vi.fn(),
}));
vi.mock('./navigation', () => ({ navigateTo: navigateToMock }));
vi.mock('../components/shared/Toast', () => ({ showToast: showToastMock }));
vi.mock('../stores/auth', () => ({ waitForPendingRefresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../stores/orgStore', () => ({
  useOrgStore: { getState: () => ({ selectOrganization: selectOrganizationMock, selectAllOrgs: selectAllOrgsMock }) },
}));

import { stashSwitchToast, consumeSwitchToast, getOrgSwitchRedirect, applyOrgSwitch } from './orgSwitch';

describe('orgSwitch toast round-trip', () => {
  beforeEach(() => sessionStorage.clear());

  it('stashes a confirmation and consumes it exactly once (no re-toast on reload)', () => {
    stashSwitchToast('Switched to Acme');
    expect(consumeSwitchToast()).toBe('Switched to Acme');
    expect(consumeSwitchToast()).toBeNull();
  });

  it('returns null when nothing was stashed', () => {
    expect(consumeSwitchToast()).toBeNull();
  });
});

describe('getOrgSwitchRedirect', () => {
  it('redirects a device detail route up to its list so the new org does not 404', () => {
    expect(getOrgSwitchRedirect('/devices/dev-1')).toBe('/devices');
  });

  it('leaves the list and sibling routes in place (plain reload)', () => {
    expect(getOrgSwitchRedirect('/devices')).toBeNull();
    expect(getOrgSwitchRedirect('/devices/compare')).toBeNull();
    expect(getOrgSwitchRedirect('/devices/groups')).toBeNull();
  });

  it('does not redirect detail routes it has no rule for (they reload in place)', () => {
    expect(getOrgSwitchRedirect('/alerts/abc123')).toBeNull();
    expect(getOrgSwitchRedirect('/settings/organizations/abc123')).toBeNull();
  });
});

describe('getOrgSwitchRedirect — organization record (#5075)', () => {
  it('redirects the record up to the organizations list (the record pins ITS org, not the switcher)', () => {
    // Reloading /organizations/<other-org> after a switch would leave the user
    // staring at the customer they just navigated away from: the record's org
    // comes from the URL, so a context switch has to leave the record entirely.
    expect(getOrgSwitchRedirect('/organizations/abc123')).toBe('/settings/organizations');
    expect(getOrgSwitchRedirect('/organizations/abc123/')).toBe('/settings/organizations');
  });

  it('leaves deeper record sub-routes and the bare prefix alone', () => {
    expect(getOrgSwitchRedirect('/organizations/abc123/anything')).toBeNull();
    expect(getOrgSwitchRedirect('/organizations')).toBeNull();
  });
});

describe('applyOrgSwitch — soft navigation instead of a full reload', () => {
  const originalLocation = window.location;
  function stubLocation(pathname: string, search = '', hash = '') {
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: { ...originalLocation, pathname, search, hash, reload: vi.fn() },
    });
  }
  beforeEach(() => {
    sessionStorage.clear();
    navigateToMock.mockReset().mockResolvedValue('soft');
    showToastMock.mockReset();
    selectOrganizationMock.mockReset();
    selectAllOrgsMock.mockReset();
  });
  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('re-navigates to the current path (query kept, hash dropped) via the view-transition router, replacing history', async () => {
    stubLocation('/devices', '?view=grid', '#dev-1');
    await applyOrgSwitch('org-b', 'Switched to B');
    expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
    expect(navigateToMock).toHaveBeenCalledWith('/devices?view=grid', { replace: true });
    expect((window.location as unknown as { reload: ReturnType<typeof vi.fn> }).reload).not.toHaveBeenCalled();
  });

  it('shows the confirmation toast itself after a soft navigation (the persisted switcher never remounts)', async () => {
    stubLocation('/devices');
    await applyOrgSwitch(null, 'Showing all');
    expect(selectAllOrgsMock).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'Showing all' });
    expect(consumeSwitchToast()).toBeNull();
  });

  it('leaves the stashed toast for the next mount when navigation fell back to a hard load', async () => {
    navigateToMock.mockResolvedValue('hard');
    stubLocation('/devices');
    await applyOrgSwitch('org-b', 'Switched to B');
    expect(showToastMock).not.toHaveBeenCalled();
    expect(consumeSwitchToast()).toBe('Switched to B');
  });

  it('redirects detail routes up to their list, and honours an explicit destination without replacing history', async () => {
    stubLocation('/devices/dev-1');
    await applyOrgSwitch('org-b', 'x');
    expect(navigateToMock).toHaveBeenLastCalledWith('/devices', { replace: true });

    await applyOrgSwitch('org-b', 'x', '/dashboard');
    expect(navigateToMock).toHaveBeenLastCalledWith('/dashboard', { replace: false });
  });
});
