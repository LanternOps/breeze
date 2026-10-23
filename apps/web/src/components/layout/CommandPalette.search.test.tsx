import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: fetchWithAuthMock,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn(async () => 'soft' as const) }));

import CommandPalette from './CommandPalette';
import { useOrgStore } from '../../stores/orgStore';
import { useUiStore } from '../../stores/uiStore';
import { i18n } from '../../lib/i18n';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function open() {
  render(<CommandPalette />);
  act(() => { useUiStore.getState().openCommandPalette(); });
}

function search(q: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } });
}

function searchCalls() {
  return fetchWithAuthMock.mock.calls.filter(([url]) => String(url).startsWith('/search?'));
}

beforeEach(async () => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) });
  useUiStore.setState({ isCommandPaletteOpen: false, isShortcutsHelpOpen: false });
  useOrgStore.setState({ currentOrgId: null });
  await i18n.changeLanguage('en');
});

afterEach(() => {
  useOrgStore.setState({ currentOrgId: null });
  window.history.replaceState(null, '', '/');
});

// #9612: the palette is a global overlay, so its results follow the org
// switcher on every page — including catalog routes (/scripts) where
// fetchWithAuth deliberately injects no ambient orgId.
describe('CommandPalette — server search follows the selected org (#9612)', () => {
  it('passes the selected org to /search', async () => {
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    const [url, init] = searchCalls()[0]!;
    expect(url).toBe('/search?q=srv-02');
    expect(init).toEqual({ orgIdOverride: ORG_A });
  });

  it('still passes the selected org on a catalog route, where ambient injection is off', async () => {
    window.history.replaceState(null, '', '/scripts');
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(searchCalls()[0]![1]).toEqual({ orgIdOverride: ORG_A });
  });

  it('sends no org in All-organizations view', async () => {
    open();
    search('srv-02');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(searchCalls()[0]![1]).toEqual({ orgIdOverride: null });
  });

  it('re-runs the search when the selected org changes', async () => {
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');
    await waitFor(() => expect(searchCalls()).toHaveLength(1));

    act(() => { useOrgStore.setState({ currentOrgId: ORG_B }); });

    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    expect(searchCalls()[1]![1]).toEqual({ orgIdOverride: ORG_B });
  });

  it('says the selected org is out of reach, not that the session expired, on a 403', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Access denied to this organization' }) });
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');

    expect(await screen.findByText("You don't have access to the selected organization.")).toBeInTheDocument();
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });
});
