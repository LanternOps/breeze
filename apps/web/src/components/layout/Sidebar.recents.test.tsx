import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (state: { user: { id: string; isPlatformAdmin: boolean; permissions: Array<{ resource: string; action: string }> } }) => unknown) =>
      selector({ user: { id: 'u1', isPlatformAdmin: false, permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../extensions/useExtensionNavigation', () => ({ useExtensionNavigation: () => [] }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar, { RECENT_EXPANDED_KEY } from './Sidebar';
import { useRecentsStore } from '../../stores/recentsStore';
import { SIDEBAR_CYCLE_MODE_EVENT } from '../../lib/keyboard/useGlobalShortcuts';
import { i18n } from '../../lib/i18n';

function seedDevices(names: string[]) {
  const s = useRecentsStore.getState();
  s.hydrate('u1');
  // Record oldest first so the first name in `names` ends up most recent.
  for (const name of [...names].reverse()) {
    vi.setSystemTime(Date.now() + 1000);
    s.recordDevice({ id: `id-${name}`, name });
  }
}

function seedPage(path: string, title: string, name?: string) {
  const s = useRecentsStore.getState();
  s.hydrate('u1');
  vi.setSystemTime(Date.now() + 1000);
  s.recordPage({ path, title });
  if (name) s.namePage(path, name);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  useRecentsStore.getState().hydrate(null);
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Sidebar — Devices & Assets label', () => {
  it('renders the unified list under its new name', () => {
    render(<Sidebar currentPath="/" />);
    const link = screen.getByRole('link', { name: 'Devices & Assets' });
    expect(link).toHaveAttribute('href', '/devices');
    expect(screen.queryByRole('link', { name: 'Devices' })).toBeNull();
  });
});

describe('Sidebar — Recent group', () => {
  it('shows nothing when nothing has been opened', () => {
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-group')).toBeNull();
    expect(screen.queryByTestId('sidebar-recent-devices')).toBeNull();
  });

  it('lists devices and named records newest first, directly under Dashboard', () => {
    seedDevices(['alpha']);
    seedPage('/organizations/o1', 'Organization', 'Acme Dental');
    seedPage('/devices', 'Devices');
    render(<Sidebar currentPath="/" />);
    const links = within(screen.getByTestId('sidebar-recent')).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Acme Dental', 'alpha']);
    expect(links[0]).toHaveAttribute('href', '/organizations/o1');
    const group = screen.getByTestId('sidebar-recent-group');
    expect(
      screen.getByRole('link', { name: 'Dashboard' }).compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      group.compareDocumentPosition(screen.getByRole('link', { name: 'Organizations' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows an icon per kind', () => {
    seedDevices(['alpha']);
    seedPage('/organizations/o1', 'Organization', 'Acme Dental');
    render(<Sidebar currentPath="/" />);
    const list = screen.getByTestId('sidebar-recent');
    expect(list.querySelector('li[data-kind="org"] svg.lucide-building-2')).not.toBeNull();
    expect(list.querySelector('li[data-kind="device"] svg.lucide-monitor')).not.toBeNull();
  });

  it('excludes the page currently open', () => {
    seedPage('/organizations/o1', 'Organization', 'Acme Dental');
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/organizations/o1" />);
    expect(screen.queryByRole('link', { name: 'Acme Dental' })).toBeNull();
    expect(within(screen.getByTestId('sidebar-recent')).getByRole('link', { name: 'alpha' })).not.toHaveAttribute('aria-current');
  });

  it('shows at most 10 entries', () => {
    seedDevices(Array.from({ length: 7 }, (_, i) => `dev${i}`));
    for (let i = 0; i < 5; i++) seedPage(`/tickets/t${i}`, 'Ticket', `T-${i}`);
    render(<Sidebar currentPath="/" />);
    expect(within(screen.getByTestId('sidebar-recent')).getAllByRole('link')).toHaveLength(10);
  });

  it('updates live when a device is opened', () => {
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    act(() => {
      vi.setSystemTime(Date.now() + 5000);
      useRecentsStore.getState().recordDevice({ id: 'id-zulu', name: 'zulu' });
    });
    const links = within(screen.getByTestId('sidebar-recent')).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['zulu', 'alpha']);
  });

  it('truncates long labels and keeps the full name in title', () => {
    const long = 'x'.repeat(200);
    seedDevices([long]);
    render(<Sidebar currentPath="/" />);
    const link = within(screen.getByTestId('sidebar-recent')).getByRole('link');
    expect(link).toHaveAttribute('title', long);
    expect((link.querySelector('span') as HTMLElement).className).toContain('truncate');
  });

  it('collapses and expands from the header, remembering under sidebar-recent', () => {
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide recent' }));
    expect(screen.queryByTestId('sidebar-recent')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show recent' })).toBeInTheDocument();
    expect(localStorage.getItem(RECENT_EXPANDED_KEY)).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Show recent' }));
    expect(screen.getByTestId('sidebar-recent')).toBeInTheDocument();
    expect(localStorage.getItem(RECENT_EXPANDED_KEY)).toBe('true');
  });

  it('starts collapsed when the user collapsed it last time', () => {
    localStorage.setItem(RECENT_EXPANDED_KEY, 'false');
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show recent' })).toBeInTheDocument();
  });

  it('ignores the old sidebar-recent-devices preference', () => {
    localStorage.setItem('sidebar-recent-devices', 'false');
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    expect(screen.getByTestId('sidebar-recent')).toBeInTheDocument();
  });

  it('hides the group in the icon rail', () => {
    localStorage.setItem('sidebar-mode', 'collapsed');
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-group')).toBeNull();
  });

  it("does not show another user's entries", () => {
    seedDevices(['alpha']);
    act(() => { useRecentsStore.getState().hydrate('u2'); });
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-group')).toBeNull();
  });

  it('no longer nests a list under Devices & Assets', () => {
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-devices')).toBeNull();
    expect(screen.queryByRole('button', { name: /recent devices/i })).toBeNull();
  });

  it('renders no Recent group on the server pass even when the store is populated', () => {
    seedDevices(['alpha']);
    expect(renderToString(<Sidebar currentPath="/" />)).not.toContain('sidebar-recent');
  });
});

describe('Sidebar — keyboard mode cycling', () => {
  it('cycles open → hover → collapsed → open on the global event', () => {
    render(<Sidebar currentPath="/" />);
    expect(localStorage.getItem('sidebar-mode')).toBe('open');
    act(() => { window.dispatchEvent(new Event(SIDEBAR_CYCLE_MODE_EVENT)); });
    expect(localStorage.getItem('sidebar-mode')).toBe('hover');
    act(() => { window.dispatchEvent(new Event(SIDEBAR_CYCLE_MODE_EVENT)); });
    expect(localStorage.getItem('sidebar-mode')).toBe('collapsed');
    act(() => { window.dispatchEvent(new Event(SIDEBAR_CYCLE_MODE_EVENT)); });
    expect(localStorage.getItem('sidebar-mode')).toBe('open');
  });
});
