import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock, authState, claimsState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: vi.fn(),
  authState: { canManagePartnerWide: true as boolean | undefined },
  claimsState: {
    value: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9' } } as unknown,
  },
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchMock,
  useAuthStore: (selector: (s: { user: { id: string; canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { id: 'user-me', canManagePartnerWide: authState.canManagePartnerWide } }),
}));
vi.mock('../../lib/authScope', () => ({ useJwtClaims: () => claimsState.value }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: unknown) => unknown) => selector({
    organizations: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Acme', status: 'active' }],
    fetchOrganizations: async () => undefined,
  }),
}));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import TicketImportPage from './TicketImportPage';
import { SOURCE_ID, WINDOW_ID, json, migrationWindow, sourceDetail } from './testFixtures';

const listed = sourceDetail();
const listedSource = Object.fromEntries(Object.entries(listed).filter(([key]) => key !== 'mappings'));

function route(over: { detail?: () => Response } = {}) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === '/ticket-imports/modules') return json(200, { data: [{ id: 'zammad', label: 'Zammad 7.2', optionsSchema: null }] });
    if (method === 'GET' && url === '/ticket-imports/sources') return json(200, { data: [listedSource] });
    if (method === 'GET' && url === `/ticket-imports/sources/${SOURCE_ID}`) return over.detail?.() ?? json(200, { data: listed });
    if (method === 'GET' && url === `/ticket-imports/sources/${SOURCE_ID}/runs`) return json(200, { data: [] });
    if (method === 'GET' && url === '/migration-windows') return json(200, { data: [migrationWindow({ status: 'closed', closedReason: 'closed_by_admin', closedAt: '2026-11-13T00:00:00.000Z' })] });
    if (method === 'GET' && url === '/partner-service-principals') return json(200, { data: [] });
    if (method === 'GET' && url === '/ticket-categories') return json(200, { data: [] });
    return json(404, { error: `unrouted ${method} ${url}` });
  });
}
const importReads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/ticket-imports'));

function setHash(hash: string) {
  window.history.replaceState(null, '', `/tickets/import${hash}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.canManagePartnerWide = true;
  claimsState.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9' } };
  setHash('');
});

describe('TicketImportPage — access (#8313 W6)', () => {
  it('refuses a partner user without access to every org, and reads nothing', async () => {
    authState.canManagePartnerWide = false;
    route();
    render(<TicketImportPage />);
    expect(screen.getByTestId('ticket-import-denied')).toBeInTheDocument();
    await Promise.resolve();
    expect(importReads()).toHaveLength(0);
  });

  it('refuses an organization or system session', () => {
    route();
    for (const scope of ['organization', 'system']) {
      claimsState.value = { status: 'resolved', claims: { scope, orgId: null, partnerId: null } };
      const view = render(<TicketImportPage />);
      expect(screen.getByTestId('ticket-import-denied')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('waits while the session is not known yet', () => {
    claimsState.value = { status: 'unresolved' };
    route();
    render(<TicketImportPage />);
    expect(screen.getByTestId('ticket-import-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-import-denied')).toBeNull();
  });
});

describe('TicketImportPage — hash state (#8313 W6)', () => {
  it('lists the sources and opening one writes #source=<id>&step=preflight', async () => {
    route();
    render(<TicketImportPage />);
    fireEvent.click(await screen.findByTestId(`ticket-import-source-open-${SOURCE_ID}`));
    expect(window.location.hash).toBe(`#source=${SOURCE_ID}&step=preflight`);
    expect(await screen.findByTestId('ticket-import-preflight')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-current-source')).toHaveTextContent('Zammad');
  });

  it('"Connect a source" writes #step=connect and shows the connect form', async () => {
    route();
    render(<TicketImportPage />);
    fireEvent.click(await screen.findByTestId('ticket-import-connect-new'));
    expect(window.location.hash).toBe('#step=connect');
    expect(await screen.findByTestId('ticket-import-connect')).toBeInTheDocument();
  });

  it('a deep link lands on its step, and the stepper moves between steps through the hash', async () => {
    setHash(`#source=${SOURCE_ID}&step=mappings`);
    route();
    render(<TicketImportPage />);
    expect(await screen.findByTestId('ticket-import-mappings')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-step-mappings')).toBeInTheDocument();
    // Step 4 (index 3) is the dry run.
    fireEvent.click(screen.getByTestId('setup-stepper-step-3'));
    expect(window.location.hash).toBe(`#source=${SOURCE_ID}&step=dry-run`);
    expect(await screen.findByTestId('ticket-import-run-dry_run')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('setup-stepper-step-7'));
    expect(await screen.findByTestId('ticket-import-close')).toBeInTheDocument();
    // The source's latest window, closed: its summary.
    expect(screen.getByTestId('ticket-import-close-summary')).toBeInTheDocument();
  });

  it('an unknown or deleted source says so', async () => {
    setHash(`#source=${SOURCE_ID}&step=preflight`);
    route({ detail: () => json(404, { error: 'not found', code: 'TICKET_IMPORT_SOURCE_NOT_FOUND' }) });
    render(<TicketImportPage />);
    expect(await screen.findByTestId('ticket-import-source-missing')).toBeInTheDocument();
  });

  it('shows the partner\'s migration windows with their summaries', async () => {
    route();
    render(<TicketImportPage />);
    expect(await screen.findByTestId(`ticket-import-window-row-${WINDOW_ID}`)).toHaveTextContent('5 tickets');
    fireEvent.click(screen.getByTestId(`ticket-import-window-toggle-${WINDOW_ID}`));
    expect(screen.getByTestId(`ticket-import-window-summary-${WINDOW_ID}`)).toHaveTextContent('Acme');
    expect(screen.queryByTestId(`ticket-import-window-close-${WINDOW_ID}`)).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/migration-windows', expect.objectContaining({ skipOrgIdInjection: true })));
  });
});
