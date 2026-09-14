// apps/web/src/components/organizations/board/OrganizationsBoardPage.render.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage, { ORG_BOARD_LENS_STORAGE_KEY, ORG_LIST_SORT_STORAGE_KEY, ROW_HIGHLIGHT_MS } from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { ALL_CAPS, ALPHA, BETA, GAMMA, NEW_ORG_ID, flush, jsonResponse, mockBoardApi, readinessFor, renderedRowIds } from './boardTestKit';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/navigation', () => ({ navigateTo }));
const applyOrgSwitchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: applyOrgSwitchMock }));
// The workspace (OrgSwitcher) selection and the partner's Service Management
// mode, read through store selectors; mutate per test before rendering.
const store = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>,
  serviceManagementMode: 'native' as 'native' | 'external' | 'off',
  fetchOrganizations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: Object.assign((selector?: (s: typeof store) => unknown) => (selector ? selector(store) : undefined), {
    getState: () => store,
  }),
}));
// Partner-scope gating (merge) and the tickets:write gate (New ticket).
const auth = vi.hoisted(() => ({
  scope: 'partner' as 'system' | 'partner' | 'organization' | null,
  permissions: [{ resource: '*', action: '*' }] as Array<{ resource: string; action: string }>,
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: auth.scope, orgId: null, partnerId: 'partner-1' } }),
  getJwtClaims: () => ({ scope: auth.scope, orgId: null, partnerId: 'partner-1' }),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: () => true,
  usePermissions: () => ({
    permissions: auth.permissions,
    can: (resource: string, action: string) =>
      auth.permissions.some((p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*')),
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const row = (id: string) => within(desktop().getByTestId(`org-board-row-${id}`));

/** ALPHA has no site; BETA (trial) lacks a contact email and has 2 open tickets (1 SLA breached); GAMMA is internal with no devices. */
function standardReadiness() {
  return {
    [ALPHA.id]: readinessFor(ALPHA, { setup: { sites: 0 } }),
    [BETA.id]: readinessFor(BETA, {
      account: { primaryContact: { name: 'Bob Beta', email: null, phone: '+1 555 0200', mobile: null } },
      tickets: { open: 2, awaitingCustomer: 1, slaBreached: 1 },
    }),
    [GAMMA.id]: readinessFor(GAMMA, { setup: { devices: 0 }, account: { primaryContact: null } }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
  fetchMock.mockReset();
  toastMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
  store.currentOrgId = null;
  store.serviceManagementMode = 'native';
  auth.scope = 'partner';
  auth.permissions = [{ resource: '*', action: '*' }];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — cold load', () => {
  it('renders the frame and skeleton rows, then rows from the list, then chips once the batch lands', async () => {
    let release: ((r: Response) => void) | undefined;
    mockBoardApi(fetchMock, { onReadiness: () => new Promise<Response>((resolve) => { release = resolve; }) });
    render(<OrganizationsBoardPage />);
    expect(screen.getByTestId('org-board-heading')).toHaveTextContent('Organizations');
    expect(screen.getByRole('button', { name: 'Add organization' })).toBeInTheDocument();
    expect(screen.getByTestId('org-board-skeleton')).toBeInTheDocument();

    await flush();
    expect(screen.queryByTestId('org-board-skeleton')).not.toBeInTheDocument();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(row(ALPHA.id).getAllByTestId('org-board-chips-pending').length).toBeGreaterThan(0);
    expect(screen.getByTestId('org-board-band-setupIncomplete-count')).toHaveTextContent('—');
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('3');

    release!(jsonResponse({ partnerId: 'partner-1', capabilities: ALL_CAPS, serviceManagementMode: 'native', orgs: Object.values(standardReadiness()) }));
    await flush();
    expect(row(ALPHA.id).getByTestId('org-board-chip-noSite')).toHaveAttribute('href', `/organizations/${ALPHA.id}#sites`);
    expect(row(ALPHA.id).getByRole('link', { name: 'No site for Alpha Ltd' })).toBeInTheDocument();
    expect(row(BETA.id).getByTestId('org-board-chip-contactEmail')).toHaveAttribute('href', `/organizations/${BETA.id}#contacts`);
    expect(row(GAMMA.id).getByTestId('org-board-chip-noDevices')).toBeInTheDocument();
    // Internal org: Account cell is a dash, never "Complete".
    expect(row(GAMMA.id).getByTitle('Not applicable')).toHaveTextContent('—');
    expect(screen.getByTestId('org-board-band-setupIncomplete-count')).toHaveTextContent('2');
    expect(screen.getByTestId('org-board-band-accountMissing-count')).toHaveTextContent('1');
    expect(screen.getByTestId('org-board-band-openTickets-count')).toHaveTextContent('1');
    expect(screen.getByTestId('org-board-band-all')).toHaveTextContent('1 trial · 0 suspended');
    expect(screen.getByTestId('org-board-band-openTickets')).toHaveTextContent('1 SLA breached');
    expect(screen.getByTestId('org-board-footer')).toHaveTextContent('3 active accounts · 8 devices · 2 open tickets');
  });

  it('shows the empty state with Add organization when there are no organizations', async () => {
    mockBoardApi(fetchMock, { orgs: [] });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(within(screen.getByTestId('org-board-empty')).getByRole('button', { name: 'Add organization' })).toBeInTheDocument();
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('0');
  });

  it('shows the error card with Try again when the list cannot load', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'boom' }, false, 500));
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-error')).toHaveTextContent('Failed to fetch organizations');
    mockBoardApi(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
  });
});

describe('OrganizationsBoardPage — lens, filters, sort', () => {
  it('the Setup lens hides the Account column, writes the hash and remembers itself per browser', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().getByRole('columnheader', { name: 'Account data' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-board-lens-setup'));
    expect(screen.getByTestId('org-board-lens-setup')).toHaveAttribute('aria-pressed', 'true');
    expect(desktop().queryByRole('columnheader', { name: 'Account data' })).not.toBeInTheDocument();
    expect(desktop().getByRole('columnheader', { name: 'Setup' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#lens=setup&filter=all');
    expect(window.localStorage.getItem(ORG_BOARD_LENS_STORAGE_KEY)).toBe('setup');
  });

  it('a filter whose evidence the lens hides switches the lens to Both for that view (without overwriting the stored lens)', async () => {
    window.localStorage.setItem(ORG_BOARD_LENS_STORAGE_KEY, 'account');
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().queryByRole('columnheader', { name: 'Setup' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('org-board-filter-setupIncomplete'));
    expect(screen.getByTestId('org-board-lens-both')).toHaveAttribute('aria-pressed', 'true');
    expect(desktop().getByRole('columnheader', { name: 'Setup' })).toBeInTheDocument();
    expect(renderedRowIds()).toEqual([ALPHA.id, GAMMA.id]);
    expect(window.location.hash).toBe('#lens=both&filter=setupIncomplete');
    expect(window.localStorage.getItem(ORG_BOARD_LENS_STORAGE_KEY)).toBe('account');
  });

  it('a band cell applies its filter and reads as pressed alongside the chip', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(screen.getByTestId('org-board-band-openTickets'));
    expect(renderedRowIds()).toEqual([BETA.id]);
    expect(screen.getByTestId('org-board-band-openTickets')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-filter-openTickets')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-filter-openTickets-count')).toHaveTextContent('1');
  });

  it('Trial narrows by status and its count is known before any batch lands', async () => {
    mockBoardApi(fetchMock, { onReadiness: () => new Promise<Response>(() => undefined) });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-filter-trial-count')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('org-board-filter-trial'));
    expect(renderedRowIds()).toEqual([BETA.id]);
  });

  it('a hash deep link restores lens and filter on mount', async () => {
    window.location.hash = 'lens=account&filter=accountMissing';
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-lens-account')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-filter-accountMissing')).toHaveAttribute('aria-pressed', 'true');
    expect(renderedRowIds()).toEqual([BETA.id]);
  });

  it('search matches name, contact name and email; Clear filters resets search and filter', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    const search = screen.getByRole('searchbox', { name: 'Search organizations, contacts and emails' });
    fireEvent.change(search, { target: { value: 'jane@' } });
    expect(renderedRowIds()).toEqual([ALPHA.id]);
    fireEvent.change(search, { target: { value: 'bob beta' } });
    expect(renderedRowIds()).toEqual([BETA.id]);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByTestId('org-board-no-matches')).toHaveTextContent('No organizations match your search or filter.');
    fireEvent.click(screen.getByTestId('org-board-clear-filters'));
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(search).toHaveValue('');
  });

  it('sorts by open tickets (desc, then name) and by name; only Manual order shows the handle; the choice is remembered', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().getAllByTestId('org-board-drag-handle')).toHaveLength(3);
    fireEvent.change(screen.getByTestId('org-board-sort'), { target: { value: 'tickets' } });
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ORG_LIST_SORT_STORAGE_KEY)).toBe('tickets');
    fireEvent.click(desktop().getByTestId('org-board-sort-name'));
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(screen.getByTestId('org-board-sort')).toHaveValue('name');
  });

  it('adopts a remembered sort on mount and ignores the retired "devices" value', async () => {
    window.localStorage.setItem(ORG_LIST_SORT_STORAGE_KEY, 'name');
    mockBoardApi(fetchMock);
    const { unmount } = render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-sort')).toHaveValue('name');
    unmount();
    window.localStorage.setItem(ORG_LIST_SORT_STORAGE_KEY, 'devices');
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-sort')).toHaveValue('manual');
  });
});

describe('OrganizationsBoardPage — readiness states', () => {
  it('a failed batch shows Unavailable on its rows and "partial" with Try again in the band; retry fills them in', async () => {
    mockBoardApi(fetchMock, {
      readiness: standardReadiness(),
      onReadiness: (_ids, call) => (call === 1 ? jsonResponse({ error: 'boom' }, false, 500) : undefined),
    });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(row(ALPHA.id).getAllByTestId('org-board-chips-unavailable').length).toBeGreaterThan(0);
    expect(screen.getByTestId('org-board-band-partial')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-board-band-retry'));
    await flush();
    expect(screen.queryByTestId('org-board-band-partial')).not.toBeInTheDocument();
    expect(row(ALPHA.id).getByTestId('org-board-chip-noSite')).toBeInTheDocument();
  });

  it('a section absent from capabilities hides its column, band cell, filter and sort option — never zeros', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness(), capabilities: { ...ALL_CAPS, tickets: false } });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().queryByRole('columnheader', { name: 'Open tickets' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-band-openTickets')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-filter-openTickets')).not.toBeInTheDocument();
    const options = Array.from(screen.getByTestId('org-board-sort').querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['manual', 'name']);
    expect(screen.getByTestId('org-board-footer')).toHaveTextContent('3 active accounts · 8 devices');
    expect(screen.getByTestId('org-board-footer')).not.toHaveTextContent('open tickets');
  });

  it('phone cards carry a single "Still needed" list per org', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    const card = within(screen.getByTestId('responsive-table-cards')).getByTestId(`org-board-card-${ALPHA.id}`);
    expect(within(card).getByText('Still needed')).toBeInTheDocument();
    expect(within(card).getByTestId('org-board-card-chip-noSite')).toBeInTheDocument();
  });

  it('a bare uuid hash scrolls to, focuses and briefly highlights that row', async () => {
    window.location.hash = BETA.id;
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().getByTestId(`org-board-row-${BETA.id}`)).toHaveAttribute('data-highlighted', 'true');
    expect(row(BETA.id).getByTestId(`org-board-name-${BETA.id}`)).toHaveAttribute('tabindex', '0');
    await flush(ROW_HIGHLIGHT_MS);
    expect(desktop().getByTestId(`org-board-row-${BETA.id}`)).not.toHaveAttribute('data-highlighted');
  });

  it('row click opens the record', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(desktop().getByTestId(`org-board-row-${ALPHA.id}`));
    expect(navigateTo).toHaveBeenCalledWith(`/organizations/${ALPHA.id}`);
  });
});

describe('OrganizationsBoardPage — add organization', () => {
  it('submits the Add organization dialog, POSTs the values, refreshes, closes, toasts and highlights the new row', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();

    fireEvent.click(screen.getByTestId('org-board-add'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'New Co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await flush();

    const postCall = fetchMock.mock.calls.find(([url, init]) => url === '/orgs/organizations' && init?.method === 'POST');
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall![1]?.body)) as { name: string; slug: string; type: string; status: string };
    expect(body).toMatchObject({ name: 'New Co', slug: 'new-co', type: 'customer', status: 'active' });

    // Modal closed.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Success toast names the created org.
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('New Co') }));
    // Hash points at the new org id, driving the highlight.
    expect(window.location.hash).toBe(`#${NEW_ORG_ID}`);

    await flush();
    expect(renderedRowIds()).toContain(NEW_ORG_ID);
    expect(desktop().getByTestId(`org-board-row-${NEW_ORG_ID}`)).toHaveAttribute('data-highlighted', 'true');
  });
});
