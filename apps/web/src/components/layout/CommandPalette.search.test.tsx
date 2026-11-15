import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: fetchWithAuthMock,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn(async () => 'soft' as const) }));

import CommandPalette from './CommandPalette';
import { useOrgStore, type Organization } from '../../stores/orgStore';
import { useUiStore } from '../../stores/uiStore';
import { i18n, loadLocale } from '../../lib/i18n';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const org = (id: string, name: string) => ({ id, name, partnerId: 'partner-1', status: 'active' }) as Organization;
const TWO_ORGS = [org(ORG_A, 'Acme'), org(ORG_B, 'Vega Corp')];

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

function respondWith(results: unknown[]) {
  fetchWithAuthMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results }) });
}

beforeEach(async () => {
  fetchWithAuthMock.mockReset();
  respondWith([]);
  useUiStore.setState({ isCommandPaletteOpen: false, isShortcutsHelpOpen: false });
  useOrgStore.setState({ currentOrgId: null, organizations: TWO_ORGS });
  await i18n.changeLanguage('en');
});

afterEach(() => {
  useOrgStore.setState({ currentOrgId: null, organizations: [] });
  window.history.replaceState(null, '', '/');
});

// #11803: Cmd+K searches every customer the user can access. The customer
// selected in the header only ranks its matches first, unless the user turns
// on "This customer only" (off by default). Keeps #9612's useful parts: the
// selected customer still matters on every page, including catalog routes
// where fetchWithAuth injects no ambient orgId.
describe('CommandPalette — searches every customer, header customer ranks first (#11803)', () => {
  it('searches every customer and sends the selected one as a ranking hint only', async () => {
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    const [url, init] = searchCalls()[0]!;
    expect(url).toBe(`/search?q=srv-02&preferOrgId=${ORG_A}`);
    // null = never inject the ambient org: the API must not narrow.
    expect(init).toEqual({ orgIdOverride: null });
  });

  it('behaves the same on a catalog route, where ambient injection is off', async () => {
    window.history.replaceState(null, '', '/scripts');
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(searchCalls()[0]).toEqual([`/search?q=srv-02&preferOrgId=${ORG_A}`, { orgIdOverride: null }]);
  });

  it('sends no org at all in All-organizations view, and offers no toggle', async () => {
    open();
    search('srv-02');

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(searchCalls()[0]).toEqual(['/search?q=srv-02', { orgIdOverride: null }]);
    expect(screen.queryByTestId('palette-this-customer-only')).toBeNull();
  });

  it('"This customer only" is off by default and narrows to the selected customer when turned on', async () => {
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    const toggle = screen.getByTestId('palette-this-customer-only') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('This customer only')).toBeInTheDocument();
    search('srv-02');
    await waitFor(() => expect(searchCalls()).toHaveLength(1));

    fireEvent.click(toggle);

    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    expect(searchCalls()[1]).toEqual(['/search?q=srv-02', { orgIdOverride: ORG_A }]);
    expect(toggle.checked).toBe(true);
  });

  it('offers no toggle to a user who can see only one customer', async () => {
    useOrgStore.setState({ currentOrgId: ORG_A, organizations: [org(ORG_A, 'Acme')] });
    open();

    expect(screen.queryByTestId('palette-this-customer-only')).toBeNull();
  });

  it('re-runs the search when the selected customer changes', async () => {
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');
    await waitFor(() => expect(searchCalls()).toHaveLength(1));

    act(() => { useOrgStore.setState({ currentOrgId: ORG_B }); });

    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    expect(searchCalls()[1]![0]).toBe(`/search?q=srv-02&preferOrgId=${ORG_B}`);
  });

  it('says the selected customer is out of reach, not that the session expired, on a 403', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Access denied to this organization' }) });
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');

    expect(await screen.findByText("You don't have access to the selected organization.")).toBeInTheDocument();
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });
});

describe('CommandPalette — each result names its customer (#11803)', () => {
  const RESULTS = [
    { id: 'dev-1', type: 'devices', title: 'srv-02', orgId: ORG_A, orgName: 'Acme' },
    { id: 'dev-2', type: 'devices', title: 'srv-02-b', orgId: ORG_B, orgName: 'Vega Corp' },
    { id: 'script-1', type: 'scripts', title: 'srv-02 cleanup', orgId: null, orgName: null },
  ];

  function orgLabels() {
    return screen.queryAllByTestId('palette-item-org').map((el) => el.textContent);
  }

  it('labels every server result with its customer, and a partner-wide script as partner-wide', async () => {
    respondWith(RESULTS);
    open();
    search('srv-02');

    const device = await screen.findByText('srv-02-b');
    const row = device.closest('button')!;
    expect(within(row).getByTestId('palette-item-org').textContent).toBe('Vega Corp');
    expect(orgLabels()).toEqual(['Acme', 'Vega Corp', 'Partner-wide']);
  });

  it('drops the labels when the search is narrowed to one customer', async () => {
    respondWith(RESULTS.slice(0, 1));
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    fireEvent.click(screen.getByTestId('palette-this-customer-only'));
    search('srv-02');

    await screen.findByText('srv-02');
    expect(orgLabels()).toEqual([]);
  });

  it('shows no labels to a user who can see only one customer', async () => {
    respondWith(RESULTS.slice(0, 1));
    useOrgStore.setState({ organizations: [org(ORG_A, 'Acme')] });
    open();
    search('srv-02');

    await screen.findByText('srv-02');
    expect(orgLabels()).toEqual([]);
  });

  it('localizes the toggle and the partner-wide label', async () => {
    await loadLocale('de-DE');
    await i18n.changeLanguage('de-DE');
    respondWith(RESULTS.slice(2));
    useOrgStore.setState({ currentOrgId: ORG_A });
    open();
    search('srv-02');

    await screen.findByText('srv-02 cleanup');
    expect(screen.getByText('Nur dieser Kunde')).toBeInTheDocument();
    expect(orgLabels()).toEqual(['Partnerweit']);
  });
});
