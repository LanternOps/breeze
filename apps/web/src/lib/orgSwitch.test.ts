import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const { navigateToMock, showToastMock, selectOrganizationMock, selectAllOrgsMock, recordRecentOrgMock } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  showToastMock: vi.fn(),
  selectOrganizationMock: vi.fn(),
  selectAllOrgsMock: vi.fn(),
  recordRecentOrgMock: vi.fn(),
}));
vi.mock('./navigation', () => ({ navigateTo: navigateToMock }));
vi.mock('../components/shared/Toast', () => ({ showToast: showToastMock }));
vi.mock('../stores/auth', () => ({ waitForPendingRefresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../stores/orgStore', () => ({
  useOrgStore: { getState: () => ({ selectOrganization: selectOrganizationMock, selectAllOrgs: selectAllOrgsMock, recordRecentOrg: recordRecentOrgMock }) },
}));

import {
  stashSwitchToast,
  consumeSwitchToast,
  getOrgSwitchRedirect,
  applyOrgSwitch,
  keepHashAcrossOrgSwitch,
} from './orgSwitch';

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

  it('leaves /devices/posture (a fleet page, not a device record) in place', () => {
    expect(getOrgSwitchRedirect('/devices/posture')).toBeNull();
  });

  // Drift guard (#2600): the /devices/:id redirect must know every static
  // sibling page under src/pages/devices, or switching org on that page bounces
  // the user to the device list as if it were a device record.
  it('keeps every static /devices/* page in place (sibling-route drift guard)', () => {
    const pagesDir = join(__dirname, '..', 'pages', 'devices');
    const staticSiblings = readdirSync(pagesDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.astro'))
      .map((e) => e.name.replace(/\.astro$/, ''))
      .filter((name) => name !== 'index' && !name.startsWith('['));
    expect(staticSiblings.length).toBeGreaterThan(0);
    for (const name of staticSiblings) {
      expect(getOrgSwitchRedirect(`/devices/${name}`), `/devices/${name}`).toBeNull();
    }
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
    expect(getOrgSwitchRedirect('/organizations/abc123')).toBe('/organizations');
    expect(getOrgSwitchRedirect('/organizations/abc123/')).toBe('/organizations');
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
    recordRecentOrgMock.mockReset();
  });
  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('applyOrgSwitch records a real org as recent, after selecting it', async () => {
    stubLocation('/devices');
    await applyOrgSwitch('org-b', 'Switched');
    expect(recordRecentOrgMock).toHaveBeenCalledWith('org-b');
    expect(recordRecentOrgMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      selectOrganizationMock.mock.invocationCallOrder[0],
    );
  });

  it('fleet view is never recorded', async () => {
    stubLocation('/devices');
    await applyOrgSwitch(null, 'Switched');
    expect(recordRecentOrgMock).not.toHaveBeenCalled();
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

  // #9019: "Work in this org" on the org record switches and STAYS. The router
  // treats a same-page URL that carries a hash as an anchor move and never
  // swaps, so navigating there would report 'hard' and strand the toast.
  it('stays in place when the destination is exactly the current URL: no navigation, toast shown now', async () => {
    stubLocation('/organizations/org-b', '', '#sites');
    await applyOrgSwitch('org-b', 'Switched to B', '/organizations/org-b#sites');
    expect(selectOrganizationMock).toHaveBeenCalledWith('org-b');
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'Switched to B' });
    expect(consumeSwitchToast()).toBeNull();
  });

  it('still navigates when only the path matches (another tab hash, or another query)', async () => {
    stubLocation('/organizations/org-b', '', '#devices');
    await applyOrgSwitch('org-b', 'x', '/organizations/org-b#sites');
    expect(navigateToMock).toHaveBeenLastCalledWith('/organizations/org-b#sites', { replace: false });

    stubLocation('/x', '?a=1');
    await applyOrgSwitch('org-b', 'x', '/x');
    expect(navigateToMock).toHaveBeenLastCalledWith('/x', { replace: false });
  });
});

// #9954: a page whose hash is a tab (not an org-specific record) asks to keep
// it across an in-place switch. The router cannot carry it (a same-path URL
// with a hash is an anchor move, not a swap), so the hash is put back on the
// swapped-in document's URL before its island reads it.
describe('applyOrgSwitch — a page can keep its tab hash across the switch (#9954)', () => {
  const originalLocation = window.location;
  function stubLocation(pathname: string, search = '', hash = '') {
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: { ...originalLocation, pathname, search, hash, reload: vi.fn() },
    });
  }
  /** The router's soft path: the document swaps (astro:after-swap), then the promise resolves 'soft'. */
  function softNavigation() {
    navigateToMock.mockImplementation(async () => {
      document.dispatchEvent(new Event('astro:after-swap'));
      return 'soft';
    });
  }
  let release: (() => void) | null = null;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sessionStorage.clear();
    navigateToMock.mockReset();
    showToastMock.mockReset();
    replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
  });
  afterEach(() => {
    release?.();
    release = null;
    replaceStateSpy.mockRestore();
  });
  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('re-applies the kept hash on the swapped-in URL and tells already-mounted listeners', async () => {
    softNavigation();
    stubLocation('/integrations', '', '#m365');
    release = keepHashAcrossOrgSwitch(() => 'm365');
    const onHashChange = vi.fn();
    window.addEventListener('hashchange', onHashChange);
    try {
      await applyOrgSwitch('org-b', 'Switched to B');
    } finally {
      window.removeEventListener('hashchange', onHashChange);
    }
    // Still a hashless soft navigation: with the hash the router would not swap.
    expect(navigateToMock).toHaveBeenCalledWith('/integrations', { replace: true });
    expect(replaceStateSpy).toHaveBeenCalledWith(window.history.state, '', '/integrations#m365');
    expect(onHashChange).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'Switched to B' });
  });

  it('asks the page for its hash at switch time (the tab may have changed since mount), tolerating a leading #', async () => {
    softNavigation();
    stubLocation('/integrations', '?x=1', '#webhooks');
    let current = 'webhooks';
    release = keepHashAcrossOrgSwitch(() => `#${current}`);
    current = 'psa';
    await applyOrgSwitch('org-b', 'x');
    expect(replaceStateSpy).toHaveBeenCalledWith(window.history.state, '', '/integrations?x=1#psa');
  });

  it('keeps nothing when no page asked, or the page has no hash to keep', async () => {
    softNavigation();
    stubLocation('/devices', '', '#dev-1');
    await applyOrgSwitch('org-b', 'x');
    expect(replaceStateSpy).not.toHaveBeenCalled();

    release = keepHashAcrossOrgSwitch(() => null);
    await applyOrgSwitch('org-b', 'x');
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('still switches, keeping nothing, when the page provider throws', async () => {
    softNavigation();
    stubLocation('/integrations', '', '#m365');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    release = keepHashAcrossOrgSwitch(() => { throw new Error('page broke'); });
    await applyOrgSwitch('org-b', 'Switched to B');
    expect(navigateToMock).toHaveBeenCalledWith('/integrations', { replace: true });
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'Switched to B' });
    warnSpy.mockRestore();
  });

  it('keeps nothing once the page has released its claim', async () => {
    softNavigation();
    stubLocation('/integrations', '', '#m365');
    keepHashAcrossOrgSwitch(() => 'm365')();
    await applyOrgSwitch('org-b', 'x');
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('a stale release does not drop the claim of the page that replaced it', async () => {
    softNavigation();
    stubLocation('/integrations', '', '#m365');
    const releaseOld = keepHashAcrossOrgSwitch(() => 'old');
    release = keepHashAcrossOrgSwitch(() => 'm365');
    releaseOld();
    await applyOrgSwitch('org-b', 'x');
    expect(replaceStateSpy).toHaveBeenCalledWith(window.history.state, '', '/integrations#m365');
  });

  it('never carries the hash to a redirect or an explicit destination (a different page)', async () => {
    softNavigation();
    release = keepHashAcrossOrgSwitch(() => 'sites');
    stubLocation('/devices/dev-1', '', '#sites');
    await applyOrgSwitch('org-b', 'x');
    expect(navigateToMock).toHaveBeenLastCalledWith('/devices', { replace: true });

    stubLocation('/integrations', '', '#sites');
    await applyOrgSwitch('org-b', 'x', '/dashboard');
    expect(navigateToMock).toHaveBeenLastCalledWith('/dashboard', { replace: false });
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('does not touch the URL when the navigation fell back to a hard load', async () => {
    navigateToMock.mockResolvedValue('hard');
    stubLocation('/integrations', '', '#m365');
    release = keepHashAcrossOrgSwitch(() => 'm365');
    const onHashChange = vi.fn();
    window.addEventListener('hashchange', onHashChange);
    try {
      await applyOrgSwitch('org-b', 'x');
    } finally {
      window.removeEventListener('hashchange', onHashChange);
    }
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(onHashChange).not.toHaveBeenCalled();
  });

  it('leaves a later, unrelated swap alone', async () => {
    navigateToMock.mockResolvedValue('soft');
    stubLocation('/integrations', '', '#m365');
    release = keepHashAcrossOrgSwitch(() => 'm365');
    await applyOrgSwitch('org-b', 'x');
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});
