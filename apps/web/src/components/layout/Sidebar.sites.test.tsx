import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #9794 — the Sites nav item (spec §4.1, Decisions 1–2): shown to anyone with
// sites:read, org-scoped users and single-site orgs included; hidden without it.

type Perm = { resource: string; action: string };

const state = vi.hoisted(() => ({
  scope: 'organization' as 'organization' | 'partner',
  user: { isPlatformAdmin: false, permissions: [] as Perm[] },
}));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({
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
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: state.scope }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

const ORG_TECH: Perm[] = [
  { resource: 'devices', action: 'read' },
  { resource: 'sites', action: 'read' },
];

beforeEach(() => {
  // Any list the sidebar happens to fetch answers with one org and one site.
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'site-1', name: 'Only Site' }], pagination: { total: 1 } }),
  } as Response);
  state.scope = 'organization';
  state.user.permissions = [];
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  localStorage.setItem('sidebar-sections', JSON.stringify({ 'fleet-management': true }));
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => vi.clearAllMocks());

describe('Sidebar — Sites entry (#9794)', () => {
  it('an org-scoped user with sites:read sees nav-sites linking to /settings/sites', async () => {
    state.user.permissions = ORG_TECH;
    render(<Sidebar currentPath="/" />);

    const link = await screen.findByTestId('nav-sites');
    expect(link).toHaveAttribute('href', '/settings/sites');
    expect(link).toHaveTextContent('Sites');
  });

  it('a user without sites:read does not see it', async () => {
    state.user.permissions = [{ resource: 'devices', action: 'read' }];
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(container.querySelector('a[href="/devices/groups"]')).not.toBeNull());
    expect(screen.queryByTestId('nav-sites')).toBeNull();
  });

  it('a partner user whose orgs have a single site still sees it (Decision 2: always shown)', async () => {
    state.scope = 'partner';
    state.user.permissions = ORG_TECH;
    render(<Sidebar currentPath="/" />);

    expect(await screen.findByTestId('nav-sites')).toBeInTheDocument();
  });

  it('exposes the section header as a testid hook whose aria-expanded reflects the expanded state (#10040)', async () => {
    state.user.permissions = ORG_TECH;
    render(<Sidebar currentPath="/" />);

    const header = await screen.findByTestId('nav-section-toggle-fleet-management');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('nav-sites')).toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });
});
