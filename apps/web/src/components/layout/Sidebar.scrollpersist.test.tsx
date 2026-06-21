import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sidebar scroll-position persistence across Astro View Transitions (#1714).
// The sidebar island is rendered with `transition:persist`, but its scrollable
// nested `<nav>` is not covered by Astro's viewport-level scroll restoration, so
// it resets to scrollTop=0 after every page swap. The fix captures scrollTop on
// `astro:before-swap` and reapplies it on `astro:after-swap`.

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
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

function getNav(container: HTMLElement): HTMLElement {
  const nav = container.querySelector('nav[data-tour="sidebar-nav"]');
  if (!nav) throw new Error('sidebar nav not found');
  return nav as HTMLElement;
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar scroll-position persistence (#1714)', () => {
  it('restores the nav scrollTop after an astro swap resets it to 0', async () => {
    const { container } = render(<Sidebar currentPath="/" />);
    const nav = getNav(container);

    // Simulate a user scrolled down to a lower nav item.
    nav.scrollTop = 240;

    // astro:before-swap fires while the old DOM is still live → capture.
    document.dispatchEvent(new Event('astro:before-swap'));

    // Astro/theme-bootstrap reset the scrollable element to the top during swap.
    nav.scrollTop = 0;

    // astro:after-swap fires once the new DOM is in place → restore.
    document.dispatchEvent(new Event('astro:after-swap'));

    await waitFor(() => expect(nav.scrollTop).toBe(240));
  });

  it('does not clobber scrollTop when no position was captured (no prior swap)', async () => {
    const { container } = render(<Sidebar currentPath="/" />);
    const nav = getNav(container);

    nav.scrollTop = 120;
    // after-swap with nothing captured must leave the live value untouched.
    document.dispatchEvent(new Event('astro:after-swap'));

    expect(nav.scrollTop).toBe(120);
  });

  it('preserves a scrolled-to-top position (scrollTop 0 is a real value)', async () => {
    const { container } = render(<Sidebar currentPath="/" />);
    const nav = getNav(container);

    nav.scrollTop = 0;
    document.dispatchEvent(new Event('astro:before-swap'));
    // Something else nudges it mid-swap; restore must pin it back to 0.
    nav.scrollTop = 75;
    document.dispatchEvent(new Event('astro:after-swap'));

    await waitFor(() => expect(nav.scrollTop).toBe(0));
  });
});
