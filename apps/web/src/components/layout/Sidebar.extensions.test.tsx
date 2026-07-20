import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: { user: { isPlatformAdmin: boolean; permissions: Array<{ resource: string; action: string }> } }) => unknown) =>
      selector({ user: { isPlatformAdmin: false, permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: vi.fn(() => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() })),
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

const useExtensionNavigationMock = vi.hoisted(() => vi.fn());
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => useExtensionNavigationMock(),
}));

import Sidebar, { navSections, topLevelNav } from './Sidebar';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  useExtensionNavigationMock.mockReset();
  useExtensionNavigationMock.mockReturnValue([]);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar extension navigation', () => {
  it('renders namespaced extension links in a section AFTER every core section', async () => {
    useExtensionNavigationMock.mockReturnValue([
      { name: 'Demo Dashboard', href: '/extensions/demo/dashboard' },
    ]);

    render(<Sidebar currentPath="/" />);

    const nav = (await screen.findByText('Demo Dashboard')).closest('nav');
    expect(nav).not.toBeNull();

    // Every core top-level + section item, followed by the extension link,
    // must appear in that exact relative order in the rendered DOM.
    const allLabels = [
      ...topLevelNav.map((i) => i.name),
      ...navSections.flatMap((s) => s.items.map((i) => i.name)),
    ];
    // { hidden: true } — sections default to visually collapsed (aria-hidden
    // via CSS grid-collapse, not unmounted), which role queries otherwise
    // exclude by default; we only care about DOM order here.
    const links = within(nav!).getAllByRole('link', { hidden: true }).map((el) => el.textContent?.trim());
    const demoIndex = links.indexOf('Demo Dashboard');
    expect(demoIndex).toBeGreaterThan(-1);
    for (const label of allLabels) {
      const idx = links.indexOf(label);
      if (idx === -1) continue; // some items are collapsed/hidden pending expand state
      expect(idx).toBeLessThan(demoIndex);
    }

    const link = screen.getByText('Demo Dashboard').closest('a');
    expect(link).toHaveAttribute('href', '/extensions/demo/dashboard');
  });

  it('shows no Extensions section when no extension contributes navigation', async () => {
    useExtensionNavigationMock.mockReturnValue([]);
    render(<Sidebar currentPath="/" />);
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Demo Dashboard')).not.toBeInTheDocument();
  });

  it('a registry failure (empty list from the hook) hides only the Extensions section — core nav renders normally', async () => {
    useExtensionNavigationMock.mockReturnValue([]);
    render(<Sidebar currentPath="/" />);

    // Core top-level items still render.
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Devices')).toBeInTheDocument();
    // No stray "Extensions" section header.
    expect(screen.queryByText('Extensions')).not.toBeInTheDocument();
  });

  it('renders extension links in the order the hook returns them (hook owns ordering)', async () => {
    useExtensionNavigationMock.mockReturnValue([
      { name: 'Alpha First', href: '/extensions/alpha/first' },
      { name: 'Zeta B', href: '/extensions/zeta/b' },
    ]);
    render(<Sidebar currentPath="/" />);

    const nav = (await screen.findByText('Alpha First')).closest('nav');
    // { hidden: true } — sections default to visually collapsed (aria-hidden
    // via CSS grid-collapse, not unmounted), which role queries otherwise
    // exclude by default; we only care about DOM order here.
    const links = within(nav!).getAllByRole('link', { hidden: true }).map((el) => el.textContent?.trim());
    const alphaIdx = links.indexOf('Alpha First');
    const zetaIdx = links.indexOf('Zeta B');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(alphaIdx);
  });
});
