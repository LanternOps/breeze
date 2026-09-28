import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const navigateToMock = vi.hoisted(() => vi.fn(async () => 'soft' as const));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

import CommandPalette from './CommandPalette';
import { useRecentsStore } from '../../stores/recentsStore';
import { useUiStore } from '../../stores/uiStore';
import { i18n } from '../../lib/i18n';

function seed() {
  const s = useRecentsStore.getState();
  s.hydrate('u1');
  s.recordDevice({ id: 'id-bravo', name: 'bravo' });
  s.recordDevice({ id: 'id-alpha', name: 'alpha' });
  s.recordPage({ path: '/scripts', title: 'Scripts' });
  s.recordPage({ path: '/alerts?severity=critical', title: 'Alerts' });
}

function sectionHeadings(): string[] {
  return screen.getAllByTestId('palette-section-heading').map((el) => el.textContent?.trim() ?? '');
}

beforeEach(async () => {
  localStorage.clear();
  useRecentsStore.getState().hydrate(null);
  useUiStore.setState({ isCommandPaletteOpen: false, isShortcutsHelpOpen: false });
  fetchWithAuthMock.mockReset();
  // Never resolves by default: proves local recents render without the server.
  fetchWithAuthMock.mockReturnValue(new Promise(() => {}));
  navigateToMock.mockClear();
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CommandPalette — recents', () => {
  it('opens from the ui store and shows recent devices, then recent pages, then quick actions', () => {
    seed();
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { useUiStore.getState().openCommandPalette(); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(sectionHeadings()).toEqual(['Recent devices', 'Recently visited', 'Quick actions']);

    const devices = screen.getByTestId('palette-section-recent-devices');
    expect(within(devices).getAllByTestId('palette-item-title').map((b) => b.textContent)).toEqual(['alpha', 'bravo']);
    const pages = screen.getByTestId('palette-section-recent-pages');
    const pageButtons = within(pages).getAllByRole('button');
    expect(pageButtons[0]).toHaveTextContent('Alerts');
    expect(pageButtons[0]).toHaveTextContent('/alerts?severity=critical');
  });

  it('omits the recent sections when there is nothing to show', () => {
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    expect(sectionHeadings()).toEqual(['Quick actions']);
  });

  it('Enter on the freshly opened palette jumps back to the most recent device', () => {
    seed();
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(navigateToMock).toHaveBeenCalledWith('/devices/id-alpha');
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
  });

  it('clicking a recent page navigates to its full path', () => {
    seed();
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    fireEvent.click(screen.getByRole('button', { name: /Scripts/ }));
    expect(navigateToMock).toHaveBeenCalledWith('/scripts');
  });

  it('filters recents locally while the server search is still pending', () => {
    seed();
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alp' } });
    const recent = screen.getByTestId('palette-section-recent');
    expect(within(recent).getAllByTestId('palette-item-title').map((b) => b.textContent)).toEqual(['alpha']);
    expect(screen.queryByTestId('palette-section-recent-devices')).toBeNull();
    expect(screen.queryByTestId('palette-section-quick-actions')).toBeNull();
  });

  it('keeps local matches visible and selectable while the server search loads', () => {
    vi.useFakeTimers();
    try {
      seed();
      render(<CommandPalette />);
      act(() => { useUiStore.getState().openCommandPalette(); });
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alp' } });
      act(() => { vi.advanceTimersByTime(250); }); // past the debounce → fetch pending
      expect(screen.getByText('Searching…')).toBeInTheDocument();
      expect(within(screen.getByTestId('palette-section-recent')).getByRole('button')).toHaveTextContent('alpha');
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(navigateToMock).toHaveBeenCalledWith('/devices/id-alpha');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the previous query\'s server results as soon as a new search starts', async () => {
    seed();
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ id: 's1', type: 'scripts', title: 'Old script' }] }),
    } as Response);
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old' } });
    expect(await screen.findByText('Old script')).toBeInTheDocument();
    fetchWithAuthMock.mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'older' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(screen.queryByText('Old script')).toBeNull();
  });

  it('matches recent pages by title and by path', () => {
    seed();
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'severity' } });
    const recent = screen.getByTestId('palette-section-recent');
    expect(within(recent).getAllByRole('button')).toHaveLength(1);
    expect(within(recent).getByRole('button')).toHaveTextContent('Alerts');
  });

  it('shows a named page by its item name with the page kind instead of the id path', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordPage({ path: '/billing/quotes/188ea8ed-5451-4157-87cc-a65efa4536d9', title: 'Quote' });
    s.namePage('/billing/quotes/188ea8ed-5451-4157-87cc-a65efa4536d9', 'Q-0042 Acme firewall');
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    const button = within(screen.getByTestId('palette-section-recent-pages')).getByRole('button');
    expect(button).toHaveTextContent('Q-0042 Acme firewall');
    expect(button).toHaveTextContent('Quote');
    expect(button).not.toHaveTextContent('188ea8ed');
  });

  it('numbers the first nine items and opens one with Alt/Option + its number', () => {
    seed();
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    const devices = within(screen.getByTestId('palette-section-recent-devices')).getAllByRole('button');
    expect(within(devices[0]).getByTestId('palette-item-number')).toHaveTextContent('1');
    expect(within(devices[1]).getByTestId('palette-item-number')).toHaveTextContent('2');
    const pages = within(screen.getByTestId('palette-section-recent-pages')).getAllByRole('button');
    expect(within(pages[0]).getByTestId('palette-item-number')).toHaveTextContent('3');
    // Option+3 on a Mac types "£": match on the physical key, not the character.
    fireEvent.keyDown(window, { key: '£', code: 'Digit3', altKey: true });
    expect(navigateToMock).toHaveBeenCalledWith('/alerts?severity=critical');
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
  });

  it('swallows Alt/Option + a number with no item, so no symbol lands in the search', () => {
    seed();
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    const notCancelled = fireEvent.keyDown(window, { key: '™', code: 'Digit9', altKey: true });
    expect(notCancelled).toBe(false);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('a plain number still types into the search', () => {
    seed();
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    const e = fireEvent.keyDown(window, { key: '1', code: 'Digit1' });
    expect(e).toBe(true);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('Cmd+K toggles and Escape closes through the store', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(true);
  });

  it('offers the keyboard shortcuts sheet as a quick action', () => {
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    fireEvent.click(screen.getByRole('button', { name: /Keyboard shortcuts/ }));
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(true);
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('no longer reads the retired palette-local recent list', () => {
    localStorage.setItem(
      'breeze.commandPalette.recent',
      JSON.stringify([{ key: 'old', title: 'Old thing', href: '/old', kind: 'action' }]),
    );
    render(<CommandPalette />);
    act(() => { useUiStore.getState().openCommandPalette(); });
    expect(screen.queryByText('Old thing')).toBeNull();
  });
});
