import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

import Sidebar, { RECENT_DEVICES_EXPANDED_KEY } from './Sidebar';
import { useRecentsStore } from '../../stores/recentsStore';
import { SIDEBAR_CYCLE_MODE_EVENT } from '../../lib/keyboard/useGlobalShortcuts';
import { i18n } from '../../lib/i18n';

function seedDevices(names: string[]) {
  const s = useRecentsStore.getState();
  s.hydrate('u1');
  // Record oldest first so the first name in `names` ends up most recent.
  for (const name of [...names].reverse()) s.recordDevice({ id: `id-${name}`, name });
}

beforeEach(async () => {
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

describe('Sidebar — recent devices', () => {
  it('shows nothing extra when no device has been opened', () => {
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-devices')).toBeNull();
    expect(screen.queryByRole('button', { name: /recent devices/i })).toBeNull();
  });

  it('lists the last five opened devices, newest first, under Devices & Assets', () => {
    seedDevices(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    render(<Sidebar currentPath="/" />);
    const list = screen.getByTestId('sidebar-recent-devices');
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    expect(links[0]).toHaveAttribute('href', '/devices/id-alpha');
    // Rendered directly after the Devices & Assets row.
    const devicesLink = screen.getByRole('link', { name: 'Devices & Assets' });
    expect(devicesLink.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('updates live when a device is opened', () => {
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    act(() => { useRecentsStore.getState().recordDevice({ id: 'id-zulu', name: 'zulu' }); });
    const links = within(screen.getByTestId('sidebar-recent-devices')).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['zulu', 'alpha']);
  });

  it('marks the open device as current', () => {
    seedDevices(['alpha', 'bravo']);
    render(<Sidebar currentPath="/devices/id-bravo" />);
    const list = screen.getByTestId('sidebar-recent-devices');
    expect(within(list).getByRole('link', { name: 'bravo' })).toHaveAttribute('aria-current', 'page');
    expect(within(list).getByRole('link', { name: 'alpha' })).not.toHaveAttribute('aria-current');
  });

  it('collapses and expands from the chevron, remembering the choice', () => {
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    const toggle = screen.getByRole('button', { name: 'Hide recent devices' });
    fireEvent.click(toggle);
    expect(screen.queryByTestId('sidebar-recent-devices')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show recent devices' })).toBeInTheDocument();
    expect(localStorage.getItem(RECENT_DEVICES_EXPANDED_KEY)).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Show recent devices' }));
    expect(screen.getByTestId('sidebar-recent-devices')).toBeInTheDocument();
    expect(localStorage.getItem(RECENT_DEVICES_EXPANDED_KEY)).toBe('true');
  });

  it('starts collapsed when the user collapsed it last time', () => {
    localStorage.setItem(RECENT_DEVICES_EXPANDED_KEY, 'false');
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-devices')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show recent devices' })).toBeInTheDocument();
  });

  it('hides the list in the icon rail', () => {
    localStorage.setItem('sidebar-mode', 'collapsed');
    seedDevices(['alpha']);
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-devices')).toBeNull();
  });

  it('does not show another user\'s devices', () => {
    seedDevices(['alpha']);
    act(() => { useRecentsStore.getState().hydrate('u2'); });
    render(<Sidebar currentPath="/" />);
    expect(screen.queryByTestId('sidebar-recent-devices')).toBeNull();
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
