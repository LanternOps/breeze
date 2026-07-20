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
    JSON.stringify({ 'ai-fleet': true, monitoring: true, security: true, operations: true, backup: true, reporting: true, settings: true }),
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
    expect(hasSectionHeader(container, 'Monitoring')).toBe(false);
    expect(hasSectionHeader(container, 'Security')).toBe(false);
    expect(hasSectionHeader(container, 'Backup')).toBe(false);
    expect(hasSectionHeader(container, 'Reporting')).toBe(false);
    // Sections that still have at least one visible item keep their header:
    // Operations holds the billing items it can access, and AI & Fleet has the
    // always-visible Fleet landing item.
    expect(hasSectionHeader(container, 'Operations')).toBe(true);
    expect(hasSectionHeader(container, 'AI & Fleet')).toBe(true);
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
    expect(has(container, '/settings/roles')).toBe(true);
    expect(has(container, '/security')).toBe(true);
    expect(has(container, '/reports')).toBe(true);
    expect(has(container, '/backup')).toBe(true);

    // Admin sees every section header (nothing filtered out).
    expect(hasSectionHeader(container, 'Monitoring')).toBe(true);
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
  it('hides SSO from a users:read role lacking sso:admin, but shows the other identity items', async () => {
    state.user.permissions = [{ resource: 'users', action: 'read' }];
    const { container } = render(<Sidebar currentPath="/settings/users" />);
    await waitFor(() => expect(has(container, '/settings/users')).toBe(true));

    // Access Reviews piggybacks on users:read, so it shows.
    expect(has(container, '/settings/access-reviews')).toBe(true);
    // SSO is the only item gated on sso:admin — hidden without that grant.
    expect(has(container, '/settings/sso')).toBe(false);
  });

  it('shows SSO once the role holds sso:admin', async () => {
    state.user.permissions = [
      { resource: 'users', action: 'read' },
      { resource: 'sso', action: 'admin' },
    ];
    const { container } = render(<Sidebar currentPath="/settings/users" />);
    await waitFor(() => expect(has(container, '/settings/sso')).toBe(true));
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
  });
});
