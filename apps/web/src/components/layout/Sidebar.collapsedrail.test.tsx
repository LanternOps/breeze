import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Collapsed icon rail alignment. The desktop `<nav>` is 64px wide (`w-16`)
// with `p-2`; reserving a classic scrollbar gutter (`scrollbar-gutter: stable`)
// leaves ~33px of content width, narrower than a `px-3` + 20px-icon item
// (44px). The icon then overflows its own highlight box to the right while
// section icons and dividers center in the narrower box — visibly misaligned
// on any machine with non-overlay scrollbars. In collapsed mode the rail
// therefore drops the reserved gutter and centers each icon in its full-width
// row. Open mode keeps both (`px-3` labels, stable gutter so expanding a
// section doesn't shift the labels).

type Perm = { resource: string; action: string };

const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [{ resource: '*', action: '*' }] as Perm[] },
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
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

function getNav(container: HTMLElement): HTMLElement {
  const nav = container.querySelector('nav[data-tour="sidebar-nav"]');
  if (!nav) throw new Error('sidebar nav not found');
  return nav as HTMLElement;
}

async function renderWithMode(mode: 'open' | 'collapsed') {
  localStorage.setItem('sidebar-mode', mode);
  const utils = render(<Sidebar currentPath="/devices" />);
  const nav = getNav(utils.container);
  await waitFor(() => expect(nav.querySelectorAll('a').length).toBeGreaterThan(0));
  return { ...utils, nav };
}

beforeEach(() => {
  localStorage.clear();
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
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

describe('Sidebar collapsed icon rail', () => {
  it('does not reserve a scrollbar gutter and centers every icon in its row', async () => {
    const { nav } = await renderWithMode('collapsed');

    expect(nav.style.scrollbarGutter).not.toBe('stable');

    const links = Array.from(nav.querySelectorAll('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className).toContain('justify-center');
      expect(link.className).not.toContain('px-3');
    }
    // Active item still gets its highlight — only its horizontal layout changed.
    const active = links.find((l) => l.getAttribute('href') === '/devices');
    expect(active?.className).toContain('bg-primary');
  });

  it('keeps the labelled layout and stable gutter in open mode', async () => {
    const { nav } = await renderWithMode('open');

    expect(nav.style.scrollbarGutter).toBe('stable');

    const links = Array.from(nav.querySelectorAll('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className).toContain('px-3');
      expect(link.className).not.toContain('justify-center');
    }
  });
});
