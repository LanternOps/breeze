import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_CYCLE_MODE_EVENT } from '../../lib/keyboard/useGlobalShortcuts';

// The icon rail (collapsed mode, and the forced rail on 768–1023px viewports)
// used to be a dead end: section icons were inert <div>s, so the ~55 links
// inside sections were unreachable without widening the window, and the
// tablet rail hid the only expand control. Section icons now open a labelled
// flyout, mark the section holding the current page, and the tablet rail gets
// a temporary overlay expand.

type Perm = { resource: string; action: string };

const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [{ resource: '*', action: '*' }] as Perm[] },
  tablet: false,
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
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

function getNav(container: HTMLElement): HTMLElement {
  const nav = container.querySelector('nav[data-tour="sidebar-nav"]');
  if (!nav) throw new Error('sidebar nav not found');
  return nav as HTMLElement;
}

async function renderSidebar(mode: 'open' | 'hover' | 'collapsed', currentPath = '/security/scans') {
  localStorage.setItem('sidebar-mode', mode);
  const utils = render(<Sidebar currentPath={currentPath} />);
  const nav = getNav(utils.container);
  await waitFor(() => expect(nav.querySelectorAll('a').length).toBeGreaterThan(0));
  return { ...utils, nav };
}

beforeEach(() => {
  localStorage.clear();
  state.tablet = false;
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 1023px)' ? state.tablet : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar icon rail section flyouts', () => {
  it('renders every rail section icon as a named, collapsed disclosure button', async () => {
    await renderSidebar('collapsed');

    const trigger = screen.getByTestId('nav-section-rail-security');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAccessibleName('Security');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('nav-section-flyout-security')).not.toBeInTheDocument();
  });

  it('opens a labelled flyout with the section links and closes it on Escape', async () => {
    await renderSidebar('collapsed');

    const trigger = screen.getByTestId('nav-section-rail-security');
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const flyout = screen.getByTestId('nav-section-flyout-security');
    expect(within(flyout).getByText('Security')).toBeInTheDocument();
    const scans = within(flyout).getByRole('link', { name: 'IOC Scans' });
    expect(scans).toHaveAttribute('href', '/security/scans');
    expect(scans).toHaveAttribute('aria-current', 'page');

    fireEvent.keyDown(flyout, { key: 'Escape' });
    expect(screen.queryByTestId('nav-section-flyout-security')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the flyout on an outside mousedown', async () => {
    await renderSidebar('collapsed');

    fireEvent.click(screen.getByTestId('nav-section-rail-security'));
    expect(screen.getByTestId('nav-section-flyout-security')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('nav-section-flyout-security')).not.toBeInTheDocument();
  });

  it('marks only the section that holds the current page as active', async () => {
    await renderSidebar('collapsed', '/security/scans');

    expect(screen.getByTestId('nav-section-rail-security')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('nav-section-rail-billing')).not.toHaveAttribute('data-active');
  });
});

describe('Sidebar icon rail accessible names', () => {
  it('names every rail link even after the mode changes while the pointer is over the sidebar', async () => {
    const { container } = await renderSidebar('hover', '/devices');

    // Pointer enters the hover-mode sidebar, then `[` cycles hover → collapsed
    // without a mouseleave ever firing.
    fireEvent.mouseEnter(container.querySelector('aside')!);
    act(() => {
      window.dispatchEvent(new Event(SIDEBAR_CYCLE_MODE_EVENT));
    });

    // Collapsed: the labelled section toggles are gone. Re-query the nav — the
    // pre-change element is not guaranteed to be the one on screen.
    await waitFor(() => expect(screen.queryByTestId('nav-section-toggle-security')).toBeNull());
    expect(localStorage.getItem('sidebar-mode')).toBe('collapsed');
    const links = Array.from(getNav(container).querySelectorAll('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAccessibleName();
    }
  });
});

describe('Sidebar tablet rail (768–1023px)', () => {
  it('offers an expand control that overlays the labelled sidebar and closes on Escape', async () => {
    state.tablet = true;
    // The saved desktop preference is ignored on tablet; the rail starts collapsed.
    await renderSidebar('open');

    expect(screen.queryByTestId('nav-section-toggle-security')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByTestId('nav-section-toggle-security')).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('nav-section-toggle-security')).not.toBeInTheDocument();
    // Peeking never rewrites the desktop preference.
    expect(localStorage.getItem('sidebar-mode')).toBe('open');
  });

  it('toggles the overlay from the `[` shortcut instead of cycling the desktop mode', async () => {
    state.tablet = true;
    await renderSidebar('open');

    act(() => {
      window.dispatchEvent(new Event(SIDEBAR_CYCLE_MODE_EVENT));
    });
    expect(screen.getByTestId('nav-section-toggle-security')).toBeInTheDocument();
    expect(localStorage.getItem('sidebar-mode')).toBe('open');
  });
});
