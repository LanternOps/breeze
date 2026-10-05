import { act, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #7498: the server render has no localStorage / token, so the persisted
// `user.permissions` and the JWT scope must NOT influence the first client
// render — otherwise an Org Viewer gets a hydration mismatch on every page.

const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: undefined as { resource: string; action: string }[] | undefined },
  scope: null as string | null,
  token: null as string | null,
}));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ user: state.user, tokens: state.token ? { accessToken: state.token } : null }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
vi.mock('../extensions/useExtensionNavigation', () => ({ useExtensionNavigation: () => [] }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: state.scope }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

const ORG_VIEWER = [{ resource: 'devices', action: 'read' }, { resource: 'alerts', action: 'read' }];

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as Response);
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  localStorage.setItem('sidebar-sections', JSON.stringify({ ai: true, settings: true, 'fleet-management': true }));
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => vi.restoreAllMocks());

describe('Sidebar hydration (#7498)', () => {
  it('first client render matches server HTML for an Org Viewer, no hydration error', async () => {
    // Server: no persisted store, no token.
    state.user.permissions = undefined;
    state.scope = null;
    state.token = null;
    const serverHtml = renderToString(<Sidebar currentPath="/devices" />);

    // Client: persisted permissions + org-scope token already present.
    state.user.permissions = ORG_VIEWER;
    state.scope = 'organization';
    state.token = 'tok';
    const errors: unknown[][] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    await act(async () => {
      hydrateRoot(container, <Sidebar currentPath="/devices" />, { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(errors.filter((e) => /hydrat|did not match/i.test(String(e[0])))).toEqual([]);
    errSpy.mockRestore();
    // After hydration the org-scoped user no longer sees the partner-only link.
    expect(container.querySelector('a[href="/settings/ai-usage"]')).toBeNull();
  });

  it('does not call the partner-only /orgs/partners/me for an org-scoped user', async () => {
    state.user.permissions = ORG_VIEWER;
    state.scope = 'organization';
    state.token = 'tok';
    await act(async () => { render(<Sidebar currentPath="/devices" />); });
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/orgs/partners/me');
  });

  it('does not call /orgs/partners/me while the scope is still unknown (no token yet)', async () => {
    state.user.permissions = ORG_VIEWER;
    state.scope = null;
    state.token = null;
    await act(async () => { render(<Sidebar currentPath="/devices" />); });
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/orgs/partners/me');
  });

  it('positive control: a partner-scoped user still fetches /orgs/partners/me', async () => {
    state.user.permissions = ORG_VIEWER;
    state.scope = 'partner';
    state.token = 'tok';
    await act(async () => { render(<Sidebar currentPath="/devices" />); });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me');
  });
});
