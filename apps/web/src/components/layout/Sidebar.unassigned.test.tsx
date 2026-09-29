import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Permission-aware nav regression (#1454): the dedicated billing roles must only
// see the items their grants allow. Before the fix, items like Devices, Users,
// Roles, and the Security section carried no `requiredPermission`, so a
// "Partner Billing" role (billing grants only) saw the full admin sidebar.

type Perm = { resource: string; action: string };

const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [] as Perm[], canManagePartnerWide: undefined as boolean | undefined },
}));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({
  // #5075 W04 — Sidebar now reads the Service Management mode from orgStore,
  // whose module scope calls registerOrgIdProvider on import. Without this the
  // whole suite dies at import time, before any test runs.
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: { user: typeof state.user }) => unknown) => selector({ user: state.user }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
// Unrelated to this suite's RBAC assertions — stub out so the module doesn't
// need a real (subscribable) auth store or registry fetch.
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
// Partner scope so partnerScopeOnly items aren't hidden by scope — the
// permission gate is what we're exercising here.
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';
import { useFeaturesStore } from '../../stores/featuresStore';

function has(container: HTMLElement, href: string): boolean {
  return container.querySelector(`a[href="${href}"]`) !== null;
}

// A collapsible section header is a <button> whose first <span> is the label.
function hasSectionHeader(container: HTMLElement, label: string): boolean {
  return [...container.querySelectorAll('button')].some(
    (b) => b.querySelector('span')?.textContent === label,
  );
}

const flag = vi.hoisted(() => ({ preAssignmentEnrollment: true }));

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  flag.preAssignmentEnrollment = true;
  // The runtime /config carries the platform enrollment flag; everything else 404s.
  fetchWithAuthMock.mockImplementation(async (url: string) => (url === '/config'
    ? { ok: true, status: 200, json: async () => ({ features: { preAssignmentEnrollment: flag.preAssignmentEnrollment } }) }
    : { ok: false, status: 404, json: async () => ({}) }) as Response);
  useFeaturesStore.setState({
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, toolSources: false, preAssignmentEnrollment: false },
    loaded: false,
  });
  state.user.isPlatformAdmin = false;
  state.user.permissions = [];
  state.user.canManagePartnerWide = undefined;
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  // Expand every section so collapsed children don't hide hrefs.
  localStorage.setItem(
    'sidebar-sections',
    JSON.stringify({ ai: true, 'fleet-management': true, security: true, backup: true, billing: true, reporting: true, settings: true, administration: true }),
  );
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => vi.clearAllMocks());

// Parked-device assignment is a full-partner-admin surface: the API refuses a
// partner user with a curated org selection, so the nav must not offer it.
describe('Sidebar — Unassigned Devices entry', () => {
  const ADMIN: Perm[] = [{ resource: '*', action: '*' }];

  it('is shown to a full partner admin', async () => {
    state.user.permissions = ADMIN;
    state.user.canManagePartnerWide = true;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices/unassigned')).toBe(true));
  });

  it('is hidden from a full partner admin while the platform enrollment flag is off', async () => {
    flag.preAssignmentEnrollment = false;
    state.user.permissions = ADMIN;
    state.user.canManagePartnerWide = true;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/config', expect.anything()));
    await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
    expect(has(container, '/devices/groups')).toBe(true);
    expect(has(container, '/devices/unassigned')).toBe(false);
  });

  it('is hidden from a partner user with selected org access', async () => {
    state.user.permissions = ADMIN;
    state.user.canManagePartnerWide = false;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices/groups')).toBe(true));
    expect(has(container, '/devices/unassigned')).toBe(false);
  });

  it('is hidden while the capability is unknown', async () => {
    state.user.permissions = ADMIN;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices/groups')).toBe(true));
    expect(has(container, '/devices/unassigned')).toBe(false);
  });

  it('is hidden without devices:write', async () => {
    state.user.permissions = [{ resource: 'devices', action: 'read' }];
    state.user.canManagePartnerWide = true;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices/groups')).toBe(true));
    expect(has(container, '/devices/unassigned')).toBe(false);
  });

  it('is hidden without organizations:write', async () => {
    state.user.permissions = [{ resource: 'devices', action: 'read' }, { resource: 'devices', action: 'write' }];
    state.user.canManagePartnerWide = true;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices/groups')).toBe(true));
    expect(has(container, '/devices/unassigned')).toBe(false);
  });

  it('is shown with devices:write and organizations:write', async () => {
    state.user.permissions = [
      { resource: 'devices', action: 'read' }, { resource: 'devices', action: 'write' },
      { resource: 'organizations', action: 'write' },
    ];
    state.user.canManagePartnerWide = true;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices/unassigned')).toBe(true));
  });
});
