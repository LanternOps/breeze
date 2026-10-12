import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const navigateToMock = vi.hoisted(() => vi.fn(async () => 'soft' as const));
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: fetchWithAuthMock,
}));
const claimsMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/authScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/authScope')>()),
  getJwtClaims: claimsMock,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

import CommandPalette from './CommandPalette';
import { useAuthStore } from '../../stores/auth';
import { useUiStore } from '../../stores/uiStore';
import { i18n } from '../../lib/i18n';

function setPermissions(permissions: Array<{ resource: string; action: string }>) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false, permissions },
  } as never);
}

function open() {
  render(<CommandPalette />);
  act(() => { useUiStore.getState().openCommandPalette(); });
}

function search(q: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } });
}

function settingsTitles(): string[] {
  const section = screen.queryByTestId('palette-section-settings');
  return section ? within(section).getAllByTestId('palette-item-title').map((e) => e.textContent ?? '') : [];
}

beforeEach(async () => {
  fetchWithAuthMock.mockReset();
  // Server returns no entity results and (post-fix) no settings rows.
  fetchWithAuthMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) });
  navigateToMock.mockClear();
  claimsMock.mockReset();
  claimsMock.mockReturnValue({ scope: 'partner' });
  useUiStore.setState({ isCommandPaletteOpen: false, isShortcutsHelpOpen: false });
  await i18n.changeLanguage('en');
  setPermissions([{ resource: '*', action: '*' }]);
});

describe('CommandPalette — settings come from the catalogue (#8365)', () => {
  it('finds settings pages the old 3-entry list never had, instantly', () => {
    open();
    search('enrollment');
    expect(settingsTitles()).toContain('Enrollment Keys');
    search('custom fields');
    expect(settingsTitles()).toContain('Custom Fields');
  });

  it('navigates to the catalogue href', () => {
    open();
    search('enrollment');
    fireEvent.click(screen.getByRole('button', { name: /Enrollment Keys/ }));
    expect(navigateToMock).toHaveBeenCalledWith('/settings/enrollment-keys');
  });

  it('hides settings the user lacks permission for', () => {
    setPermissions([]);
    open();
    search('enrollment');
    expect(settingsTitles()).not.toContain('Enrollment Keys');
  });

  it('hides partner-only settings for an org-scoped token', () => {
    claimsMock.mockReturnValue({ scope: 'organization' });
    open();
    search('billing');
    expect(settingsTitles()).not.toContain('Billing');
    claimsMock.mockReturnValue({ scope: 'partner' });
  });

  it('shows partner-only settings for a partner-scoped token', () => {
    open();
    search('billing');
    expect(settingsTitles()).toContain('Billing');
  });

  it('does not show the no-results message when only settings match', async () => {
    open();
    search('enrollment');
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/searching/i)).toBeNull());
    expect(screen.queryByText(i18n.t('layout.search.noResults', { ns: 'common' }))).toBeNull();
    expect(settingsTitles()).toContain('Enrollment Keys');
  });

  it('shows the no-results message when nothing matches anywhere', async () => {
    open();
    search('zzzz-no-such-thing');
    expect(await screen.findByText(i18n.t('layout.search.noResults', { ns: 'common' }))).toBeInTheDocument();
  });

  it('ignores settings rows from an older API (catalogue is the only source)', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ id: 'settings-security', type: 'settings', title: 'Stale server row', href: '/settings/profile' }],
      }),
    });
    open();
    search('profile');
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/searching/i)).toBeNull());
    expect(screen.queryByText('Stale server row')).toBeNull();
    expect(settingsTitles()).toContain('My profile');
  });
});
