import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Permission-aware nav regression (#1454): the dedicated billing roles must only
// see the items their grants allow. Before the fix, items like Devices, Users,
// Roles, and the Security section carried no `requiredPermission`, so a
// "Partner Billing" role (billing grants only) saw the full admin sidebar.

type Perm = { resource: string; action: string };

const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [] as Perm[] },
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

// The seeded role grant sets (apps/api/src/db/seed.ts).
const PARTNER_BILLING: Perm[] = [
  { resource: 'catalog', action: 'read' }, { resource: 'catalog', action: 'write' }, { resource: 'catalog', action: 'delete' },
  { resource: 'quotes', action: 'read' }, { resource: 'quotes', action: 'write' }, { resource: 'quotes', action: 'send' },
  { resource: 'invoices', action: 'read' }, { resource: 'invoices', action: 'write' }, { resource: 'invoices', action: 'send' }, { resource: 'invoices', action: 'export' },
  { resource: 'contracts', action: 'read' }, { resource: 'contracts', action: 'write' }, { resource: 'contracts', action: 'manage' },
  { resource: 'agreements', action: 'read' }, { resource: 'agreements', action: 'write' },
];
const PARTNER_TECHNICIAN: Perm[] = [
  { resource: 'backup', action: 'read' }, { resource: 'backup', action: 'write' },
  { resource: 'devices', action: 'read' }, { resource: 'devices', action: 'execute' },
  { resource: 'scripts', action: 'read' }, { resource: 'scripts', action: 'execute' },
  { resource: 'alerts', action: 'read' }, { resource: 'alerts', action: 'acknowledge' },
  { resource: 'tickets', action: 'read' },
  { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' },
  { resource: 'sites', action: 'read' },
  { resource: 'organizations', action: 'read' },
];
const ADMIN: Perm[] = [{ resource: '*', action: '*' }];

function has(container: HTMLElement, href: string): boolean {
  return container.querySelector(`a[href="${href}"]`) !== null;
}

// A collapsible section header is a <button> whose first <span> is the label.
function hasSectionHeader(container: HTMLElement, label: string): boolean {
  return [...container.querySelectorAll('button')].some(
    (b) => b.querySelector('span')?.textContent === label,
  );
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  state.user.isPlatformAdmin = false;
  state.user.permissions = [];
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

describe('Sidebar — permission-aware nav for billing vs technician vs admin', () => {
  it('Partner Billing sees only its billing items, not the admin/fleet sidebar', async () => {
    state.user.permissions = PARTNER_BILLING;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/billing/invoices')).toBe(true));

    // Billing surfaces it CAN access:
    expect(has(container, '/billing/invoices')).toBe(true);
    expect(has(container, '/billing/quotes')).toBe(true);
    expect(has(container, '/contracts')).toBe(true);
    expect(has(container, '/agreements/templates')).toBe(true);
    expect(has(container, '/settings/catalog')).toBe(true);

    // Admin / fleet surfaces it must NOT see (the #1454 regression):
    expect(has(container, '/settings/users')).toBe(false);
    expect(has(container, '/settings/roles')).toBe(false);
    expect(has(container, '/devices')).toBe(false);
    expect(has(container, '/security')).toBe(false);
    expect(has(container, '/scripts')).toBe(false);
    expect(has(container, '/backup')).toBe(false);
    expect(has(container, '/reports')).toBe(false);

    // #1629 follow-up: a section whose items are ALL permission-filtered out
    // must hide its header entirely — no empty "Monitoring/Security/Backup/
    // Reporting" group that expands to nothing.
    expect(hasSectionHeader(container, 'Fleet Management')).toBe(false);
    expect(hasSectionHeader(container, 'Security')).toBe(false);
    expect(hasSectionHeader(container, 'Backup')).toBe(false);
    expect(hasSectionHeader(container, 'Reporting')).toBe(false);
    expect(hasSectionHeader(container, 'Administration')).toBe(false);
    // Sections that still have at least one visible item keep their header:
    // Billing holds the items it can access, and AI has the always-visible
    // Fleet Orchestration landing item.
    expect(hasSectionHeader(container, 'Billing')).toBe(true);
    expect(hasSectionHeader(container, 'AI')).toBe(true);
  });

  it('Partner Technician sees fleet/ops items but no billing and no user/role admin', async () => {
    state.user.permissions = PARTNER_TECHNICIAN;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices')).toBe(true));

    // Technician surfaces it CAN access:
    expect(has(container, '/devices')).toBe(true);
    expect(has(container, '/scripts')).toBe(true);
    expect(has(container, '/alerts')).toBe(true);
    expect(has(container, '/tickets')).toBe(true);
    expect(has(container, '/reports')).toBe(true);
    expect(has(container, '/backup')).toBe(true);
    expect(has(container, '/security')).toBe(true); // gated on devices:read, which it holds

    // No billing grants → billing nav hidden:
    expect(has(container, '/billing/invoices')).toBe(false);
    expect(has(container, '/billing/quotes')).toBe(false);
    expect(has(container, '/contracts')).toBe(false);
    expect(has(container, '/agreements/templates')).toBe(false);
    expect(has(container, '/settings/catalog')).toBe(false);

    // No users grant → user/role admin hidden:
    expect(has(container, '/settings/users')).toBe(false);
    expect(has(container, '/settings/roles')).toBe(false);
  });

  it('Admin wildcard sees everything across billing, fleet, and settings', async () => {
    state.user.permissions = ADMIN;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/devices')).toBe(true));

    expect(has(container, '/devices')).toBe(true);
    expect(has(container, '/billing/invoices')).toBe(true);
    expect(has(container, '/settings/users')).toBe(true);
    // Roles moved to the /settings catalogue (#6220); the sidebar keeps the
    // daily-use items plus a More settings entry.
    expect(has(container, '/settings/roles')).toBe(false);
    expect(has(container, '/settings')).toBe(true);
    expect(has(container, '/security')).toBe(true);
    expect(has(container, '/reports')).toBe(true);
    expect(has(container, '/backup')).toBe(true);

    // Admin sees every non-platform-admin section header (nothing filtered out).
    expect(hasSectionHeader(container, 'Fleet Management')).toBe(true);
    expect(hasSectionHeader(container, 'Billing')).toBe(true);
    expect(hasSectionHeader(container, 'Security')).toBe(true);
    expect(hasSectionHeader(container, 'Backup')).toBe(true);
    expect(hasSectionHeader(container, 'Reporting')).toBe(true);
  });

  it('Dashboard stays visible regardless of permissions (ungated landing page)', async () => {
    state.user.permissions = PARTNER_BILLING;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/billing/invoices')).toBe(true));
    expect(has(container, '/')).toBe(true);
  });
});

describe('Sidebar — SSO (sso:admin) and platform-admin gating', () => {
  it('keeps the sidebar to daily-use identity items; SSO/Access Reviews live on /settings (#6220)', async () => {
    state.user.permissions = [
      { resource: 'users', action: 'read' },
      { resource: 'sso', action: 'admin' },
    ];
    const { container } = render(<Sidebar currentPath="/settings/users" />);
    await waitFor(() => expect(has(container, '/settings/users')).toBe(true));
    expect(has(container, '/settings/sso')).toBe(false);
    expect(has(container, '/settings/access-reviews')).toBe(false);
    // The catalogue entry point is ungated so every role can reach the rest.
    expect(has(container, '/settings')).toBe(true);
  });

  it('hides all platformAdminOnly items from a non-platform-admin even with wildcard permissions', async () => {
    state.user.isPlatformAdmin = false;
    state.user.permissions = ADMIN;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/settings/users')).toBe(true));

    expect(has(container, '/admin/account-deletion-requests')).toBe(false);
    expect(has(container, '/admin/quarantined')).toBe(false);
    expect(has(container, '/admin/third-party-catalog')).toBe(false);
    expect(has(container, '/admin/connected-apps')).toBe(false);
  });

  it('shows platformAdminOnly items to a platform admin', async () => {
    state.user.isPlatformAdmin = true;
    state.user.permissions = ADMIN;
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(has(container, '/admin/quarantined')).toBe(true));

    expect(has(container, '/admin/third-party-catalog')).toBe(true);
    expect(has(container, '/admin/connected-apps')).toBe(true);
    expect(hasSectionHeader(container, 'Administration')).toBe(true);
  });
  // #6498: the AI Assistant entry points at /workspace, whose every API call
  // requires ai_sessions:use (#6396). Without the gate a devices:read-only role
  // navigated straight into a composer that 403s on send.
  it('hides the AI Assistant (/workspace) entry without ai_sessions:use and shows it with', async () => {
    state.user.permissions = [{ resource: 'devices', action: 'read' }];
    const { container, rerender } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(has(container, '/devices')).toBe(true));
    expect(has(container, '/workspace')).toBe(false);

    state.user.permissions = [
      { resource: 'devices', action: 'read' },
      { resource: 'ai_sessions', action: 'use' },
    ];
    rerender(<Sidebar currentPath="/" />);
    await waitFor(() => expect(has(container, '/workspace')).toBe(true));
  });

  it('shows the AI Assistant entry to a wildcard admin', async () => {
    state.user.permissions = ADMIN;
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(has(container, '/workspace')).toBe(true));
  });

  it('shows Agreements for agreements:read alone and hides it without', async () => {
    state.user.permissions = [{ resource: 'agreements', action: 'read' }];
    const { container, rerender } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(has(container, '/agreements/templates')).toBe(true));
    // contracts:read alone must NOT reveal it — the whole point of the W02 split.
    state.user.permissions = [{ resource: 'contracts', action: 'read' }];
    rerender(<Sidebar currentPath="/" />);
    await waitFor(() => expect(has(container, '/agreements/templates')).toBe(false));
  });
});
