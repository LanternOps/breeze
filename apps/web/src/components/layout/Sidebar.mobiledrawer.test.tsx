import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../stores/uiStore';

// Below 768px the sidebar is a slide-out drawer opened from the header's menu
// button. It used to be a bare <aside> over a backdrop: no dialog role, focus
// stayed on the page behind it, Escape did nothing and the close button had no
// accessible name. It is now a modal dialog that takes focus, keeps Tab inside,
// closes on Escape and hands focus back to the menu button.

type Perm = { resource: string; action: string };

const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [{ resource: '*', action: '*' }] as Perm[] },
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
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

/** What a browser would actually Tab to: never a node inside a collapsed (`inert`) section. */
function reachable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('a[href],button:not([disabled])')).filter(
    (node) => node.tabIndex >= 0 && !node.closest('[inert]'),
  );
}

let menuButton: HTMLButtonElement;
let viewportIsMobile = true;
const mediaListeners = new Map<string, (e: { matches: boolean }) => void>();

async function openDrawer(currentPath = '/devices') {
  render(<Sidebar currentPath={currentPath} />);
  act(() => {
    useUiStore.setState({ isMobileMenuOpen: true });
  });
  const dialog = await screen.findByRole('dialog', { name: 'Menu' });
  await waitFor(() => expect(within(dialog).getAllByRole('link').length).toBeGreaterThan(0));
  return dialog;
}

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ isMobileMenuOpen: false });
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  // Phone width: every max-width query matches.
  viewportIsMobile = true;
  mediaListeners.clear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: viewportIsMobile && query.startsWith('(max-width'),
    media: query,
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => mediaListeners.set(query, cb),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  // The header's menu button lives in another island.
  menuButton = document.createElement('button');
  menuButton.setAttribute('data-testid', 'mobile-menu-toggle');
  document.body.appendChild(menuButton);
});

afterEach(() => {
  menuButton.remove();
  vi.clearAllMocks();
});

describe('Sidebar mobile drawer', () => {
  it('opens as a modal dialog named "Menu" with a named close button', async () => {
    const dialog = await openDrawer();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('id', 'mobile-nav-drawer');
    expect(within(dialog).getByRole('button', { name: 'Close menu' })).toBeInTheDocument();
  });

  it('moves focus into the drawer, onto the current page link', async () => {
    const dialog = await openDrawer('/devices');

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toHaveAttribute('aria-current', 'page');
  });

  it('closes on Escape and returns focus to the menu button', async () => {
    const dialog = await openDrawer();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useUiStore.getState().isMobileMenuOpen).toBe(false);
    expect(document.activeElement).toBe(menuButton);
  });

  it('closes from the close button and returns focus to the menu button', async () => {
    const dialog = await openDrawer();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close menu' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(menuButton);
  });

  it('wraps Tab and Shift+Tab inside the drawer, skipping collapsed sections', async () => {
    const dialog = await openDrawer();
    // A collapsed section is in the DOM but inert; it must not be a wrap target.
    expect(dialog.querySelector('[inert] a[href]')).not.toBeNull();
    const stops = reachable(dialog);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes when the viewport grows past phone width, so it never reappears unasked', async () => {
    await openDrawer();

    viewportIsMobile = false;
    act(() => {
      mediaListeners.get('(max-width: 767px)')?.({ matches: false });
    });

    await waitFor(() => expect(useUiStore.getState().isMobileMenuOpen).toBe(false));
  });
});
