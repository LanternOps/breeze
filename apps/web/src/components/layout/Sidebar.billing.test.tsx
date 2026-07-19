import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Perm = { resource: string; action: string };

// Mutable user state the mocked auth store reads from, so each test can vary the
// permission grants the sidebar sees.
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
// Unrelated to this suite's billing-gating assertions — stub out so the
// module doesn't need a real (subscribable) auth store or registry fetch.
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
// Partner scope so the billing items pass partnerScopeOnly and only the
// permission gate decides visibility.
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

function setPermissions(perms: Perm[]) {
  state.user.permissions = perms;
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  state.user.permissions = [];
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => vi.clearAllMocks());

describe('Sidebar — billing nav permission gate', () => {
  it('hides Invoices, Contracts, and Catalog when the user has no billing grants', async () => {
    setPermissions([{ resource: 'devices', action: 'read' }]);
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
    expect(container.querySelector('a[href="/billing/invoices"]')).toBeNull();
    expect(container.querySelector('a[href="/contracts"]')).toBeNull();
    expect(container.querySelector('a[href="/settings/catalog"]')).toBeNull();
  });

  it('shows only the items the user has the matching :read grant for', async () => {
    setPermissions([{ resource: 'invoices', action: 'read' }]);
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/billing/invoices"]')).not.toBeNull(),
    );
    // No contracts:read / catalog:read → those stay hidden.
    expect(container.querySelector('a[href="/contracts"]')).toBeNull();
    expect(container.querySelector('a[href="/settings/catalog"]')).toBeNull();
  });

  it('shows all billing nav for an admin wildcard grant', async () => {
    setPermissions([{ resource: '*', action: '*' }]);
    const { container } = render(<Sidebar currentPath="/fleet" />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/billing/invoices"]')).not.toBeNull(),
    );
    expect(container.querySelector('a[href="/contracts"]')).not.toBeNull();
    expect(container.querySelector('a[href="/settings/catalog"]')).not.toBeNull();
  });
});
