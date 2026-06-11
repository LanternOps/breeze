import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketsPage from './TicketsPage';
import { fetchWithAuth } from '../../stores/auth';
import type { TicketSummary } from './ticketConfig';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(vi.fn(), {
    getState: () => ({ user: { id: 'user-1' } })
  })
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

// Mock authScope so each test can control getJwtClaims behaviour.
import type { JwtClaims } from '../../lib/authScope';
const mockGetJwtClaims = vi.fn((): JwtClaims => ({ scope: 'partner', orgId: null, partnerId: 'p-1' }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => mockGetJwtClaims(),
  loginPathWithNext: () => '/login?next=%2F'
}));

// Keep the page test focused on the queue: the workbench fetch/load cycle has its own suite.
// Extended to accept refreshToken so the pane-refresh assertion can inspect props.
const capturedWorkbenchProps: Array<{ ticketId: string; refreshToken?: number }> = [];
vi.mock('./TicketWorkbench', () => ({
  default: (props: { ticketId: string; refreshToken?: number }) => {
    capturedWorkbenchProps.push({ ticketId: props.ticketId, refreshToken: props.refreshToken });
    return <div data-testid="ticket-workbench-mock" data-refresh={props.refreshToken}>{props.ticketId}</div>;
  }
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const makeTicket = (overrides: Partial<TicketSummary> & { id: string }): TicketSummary => ({
  internalNumber: null,
  subject: 'A ticket',
  status: 'open',
  priority: 'normal',
  source: 'portal',
  orgId: 'org-1',
  orgName: 'Acme Corp',
  deviceId: null,
  deviceHostname: null,
  assignedTo: null,
  assigneeName: null,
  categoryId: null,
  dueDate: null,
  slaBreachedAt: null,
  firstResponseAt: null,
  createdAt: minutesAgo(60),
  updatedAt: minutesAgo(5),
  ...overrides
});

// Healthy: no SLA configured. At-risk: ~85% of the 100-minute SLA elapsed. Breached: slaBreachedAt set.
const healthy = makeTicket({ id: 'tk-healthy', internalNumber: 'T-2026-0001', subject: 'Healthy ticket' });
const atRisk = makeTicket({
  id: 'tk-risk',
  internalNumber: 'T-2026-0002',
  subject: 'At-risk ticket',
  resolutionSlaMinutes: 100,
  createdAt: minutesAgo(85)
});
const breached = makeTicket({
  id: 'tk-breach',
  internalNumber: 'T-2026-0003',
  subject: 'Breached ticket',
  slaBreachedAt: minutesAgo(30)
});

const STATS = { data: { open: 3, unassigned: 1, mine: 0, breached: 1 } };
const ORGS = { data: [{ id: 'org-1', name: 'Acme Corp' }, { id: 'org-2', name: 'Globex' }] };
const CATEGORIES = { data: [{ id: 'cat-1', name: 'Hardware', isActive: true }, { id: 'cat-2', name: 'Retired', isActive: false }] };
const USERS = { data: [{ id: 'user-1', name: 'Todd', email: 'todd@example.com', status: 'active' }] };

const BULK_RESULT = { data: { updated: 2, skipped: 0, failed: 0, total: 2 } };

function mockListApi(
  tickets: TicketSummary[] | ((url: string) => TicketSummary[]),
  opts: { usersFail?: boolean; bulkResult?: typeof BULK_RESULT } = {}
) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/tickets/stats') return makeJsonResponse(STATS);
    if (url === '/tickets/bulk') return makeJsonResponse(opts.bulkResult ?? BULK_RESULT);
    if (url.startsWith('/tickets?')) return makeJsonResponse({ data: typeof tickets === 'function' ? tickets(url) : tickets });
    if (url.startsWith('/orgs/organizations')) return makeJsonResponse(ORGS);
    if (url === '/ticket-categories') return makeJsonResponse(CATEGORIES);
    if (url === '/users') {
      return opts.usersFail ? makeJsonResponse({ error: 'forbidden' }, false, 403) : makeJsonResponse(USERS);
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

const ticketFetchUrls = () =>
  fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.startsWith('/tickets?'));

function clearHash() {
  history.replaceState(null, '', window.location.pathname);
}

describe('TicketsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHash();
    capturedWorkbenchProps.length = 0;
    // Default to partner scope so existing tests behave as before.
    mockGetJwtClaims.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p-1' });
    // jsdom defaults to 1024, which is below the 1100px split-pane breakpoint;
    // select() would navigate to the full page instead of selecting in-pane.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  });

  it('breaching tab shows only at-risk and breached tickets', async () => {
    mockListApi([healthy, atRisk, breached]);
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');

    fireEvent.click(screen.getByTestId('tickets-tab-breaching'));

    await waitFor(() => {
      expect(screen.queryByTestId('ticket-row-tk-healthy')).toBeNull();
    });
    expect(screen.getByTestId('ticket-row-tk-risk')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-row-tk-breach')).toBeInTheDocument();
  });

  it('renders the error state (not the onboarding empty state) when the list fetch fails', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/tickets/stats') return makeJsonResponse(STATS);
      throw new Error('network down');
    });
    render(<TicketsPage />);

    await screen.findByTestId('tickets-error');
    expect(screen.queryByTestId('tickets-empty')).toBeNull();
    expect(screen.getByTestId('tickets-error-retry')).toBeInTheDocument();
  });

  it('an empty result with a search term shows the queue empty state, not onboarding', async () => {
    mockListApi([]);
    render(<TicketsPage />);

    // No tickets, open tab, no search: onboarding empty state.
    await screen.findByTestId('tickets-empty');

    fireEvent.change(screen.getByTestId('tickets-search-input'), { target: { value: 'printer' } });

    await screen.findByTestId('tickets-queue-empty');
    expect(screen.queryByTestId('tickets-empty')).toBeNull();
  });

  it('selects the ticket matching the location hash', async () => {
    window.location.hash = '#T-2026-0002';
    mockListApi([healthy, atRisk, breached]);
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-risk');

    await waitFor(() => {
      expect(screen.getByTestId('ticket-row-tk-risk')).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByTestId('ticket-row-tk-healthy')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-risk');
  });

  it('auto-selects the first row when the hash matches nothing', async () => {
    window.location.hash = '#garbage-hash';
    mockListApi([healthy, atRisk, breached]);
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');

    await waitFor(() => {
      expect(screen.getByTestId('ticket-row-tk-healthy')).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-healthy');
  });

  it('picking a priority adds priority= to the fetch and re-renders from the result', async () => {
    mockListApi((url) => (url.includes('priority=high') ? [atRisk] : [healthy, atRisk, breached]));
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');

    fireEvent.change(screen.getByTestId('tickets-filter-priority'), { target: { value: 'high' } });

    await waitFor(() => {
      expect(ticketFetchUrls().at(-1)).toContain('priority=high');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-row-tk-healthy')).toBeNull();
    });
    expect(screen.getByTestId('ticket-row-tk-risk')).toBeInTheDocument();
  });

  it('org filter adds orgId; clearing back to all removes it', async () => {
    mockListApi([healthy]);
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');
    // Wait for the org options to load before selecting one.
    await screen.findByRole('option', { name: 'Globex' });

    fireEvent.change(screen.getByTestId('tickets-filter-org'), { target: { value: 'org-2' } });
    await waitFor(() => {
      expect(ticketFetchUrls().at(-1)).toContain('orgId=org-2');
    });

    fireEvent.change(screen.getByTestId('tickets-filter-org'), { target: { value: '' } });
    await waitFor(() => {
      expect(ticketFetchUrls().at(-1)).not.toContain('orgId=');
    });
  });

  it('hides the assignee select when the users request fails', async () => {
    mockListApi([healthy], { usersFail: true });
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');
    // Other selects load their options; assignee stays hidden.
    await screen.findByRole('option', { name: 'Globex' });
    expect(screen.queryByTestId('tickets-filter-assignee')).toBeNull();
    expect(screen.getByTestId('tickets-filter-org')).toBeInTheDocument();
  });

  it('shows the assignee select when users load, disabled on assignee tabs', async () => {
    mockListApi([healthy]);
    render(<TicketsPage />);

    const select = await screen.findByTestId('tickets-filter-assignee');
    expect(select).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('tickets-tab-mine'));
    expect(screen.getByTestId('tickets-filter-assignee')).toBeDisabled();
    expect(screen.getByTestId('tickets-filter-assignee')).toHaveAttribute('title', 'Tab already filters by assignee');
  });

  describe('bulk selection', () => {
    it('selecting two rows shows the bulk bar with "2 selected" without changing the workbench selection', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      // Auto-select picks the first row for the workbench.
      await waitFor(() => {
        expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-healthy');
      });

      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));

      expect(screen.getByTestId('tickets-bulk-bar')).toHaveTextContent('2 selected');
      // Checkbox clicks must NOT drive row selection (stopPropagation / sibling layout).
      expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-healthy');
      expect(screen.getByTestId('ticket-row-tk-risk')).toHaveAttribute('aria-selected', 'false');
    });

    it('applying a status POSTs /tickets/bulk with both ids, toasts the aggregate, and clears the bar', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));

      fireEvent.change(screen.getByTestId('tickets-bulk-status'), { target: { value: 'closed' } });
      fireEvent.click(screen.getByTestId('tickets-bulk-apply'));

      await waitFor(() => {
        const bulkCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/tickets/bulk');
        expect(bulkCall).toBeTruthy();
        const body = JSON.parse(String((bulkCall![1] as RequestInit).body));
        expect(body).toEqual({
          ticketIds: expect.arrayContaining(['tk-healthy', 'tk-risk']),
          action: 'status',
          status: 'closed'
        });
        expect(body.ticketIds).toHaveLength(2);
      });

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith({ type: 'success', message: '2 updated' });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('tickets-bulk-bar')).toBeNull();
      });
    });

    it('applying an assignee POSTs action=assign; "Unassign" maps to assigneeId null', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));

      fireEvent.change(screen.getByTestId('tickets-bulk-assignee'), { target: { value: 'unassign' } });
      fireEvent.click(screen.getByTestId('tickets-bulk-apply'));

      await waitFor(() => {
        const bulkCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/tickets/bulk');
        expect(bulkCall).toBeTruthy();
        const body = JSON.parse(String((bulkCall![1] as RequestInit).body));
        expect(body).toEqual({ ticketIds: ['tk-healthy'], action: 'assign', assigneeId: null });
      });
    });

    it('switching tabs clears the selection and hides the bulk bar', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      expect(screen.getByTestId('tickets-bulk-bar')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('tickets-tab-unassigned'));

      await waitFor(() => {
        expect(screen.queryByTestId('tickets-bulk-bar')).toBeNull();
      });
    });

    it('Clear empties the selection; Select all selects every visible row', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));

      fireEvent.click(screen.getByTestId('tickets-bulk-select-all'));
      expect(screen.getByTestId('tickets-bulk-bar')).toHaveTextContent('3 selected');

      fireEvent.click(screen.getByTestId('tickets-bulk-clear'));
      await waitFor(() => {
        expect(screen.queryByTestId('tickets-bulk-bar')).toBeNull();
      });
    });
  });

  it('active filter with empty results shows clear-filters; clicking resets and refetches', async () => {
    mockListApi((url) => (url.includes('priority=') ? [] : [healthy]));
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');

    fireEvent.change(screen.getByTestId('tickets-filter-priority'), { target: { value: 'urgent' } });

    await screen.findByTestId('tickets-queue-empty');
    // Filtered-empty is the queue empty state, never the onboarding state.
    expect(screen.queryByTestId('tickets-empty')).toBeNull();

    fireEvent.click(screen.getByTestId('tickets-filters-clear'));

    await screen.findByTestId('ticket-row-tk-healthy');
    const lastUrl = ticketFetchUrls().at(-1) ?? '';
    expect(lastUrl).not.toContain('priority=');
    expect(lastUrl).not.toContain('orgId=');
    expect(lastUrl).not.toContain('categoryId=');
  });

  describe('org-scope hygiene', () => {
    it('org-scoped session: does not fetch /orgs/organizations and hides the org filter select', async () => {
      mockGetJwtClaims.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });
      mockListApi([healthy]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      // Give options effect time to settle.
      await waitFor(() => {
        expect(screen.queryByTestId('tickets-queue-loading')).toBeNull();
      });

      const allFetchUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(allFetchUrls.every((u) => !u.includes('/orgs/organizations'))).toBe(true);
      expect(screen.queryByTestId('tickets-filter-org')).toBeNull();
    });

    it('cold load: claims are null-scope at mount (memory-only token), org user still never fetches /orgs/organizations', async () => {
      // Simulate the token bootstrapping during the first authenticated fetches:
      // claims read null until any fetch has happened, organization afterwards.
      let tokenBootstrapped = false;
      mockGetJwtClaims.mockImplementation(() =>
        tokenBootstrapped
          ? { scope: 'organization', orgId: 'org-1', partnerId: null }
          : { scope: null, orgId: null, partnerId: null }
      );
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        tokenBootstrapped = true; // fetchWithAuth refreshes the access token
        if (url === '/tickets/stats') return makeJsonResponse(STATS);
        if (url.startsWith('/tickets?')) return makeJsonResponse({ data: [healthy] });
        if (url.startsWith('/orgs/organizations')) return makeJsonResponse(ORGS);
        if (url === '/ticket-categories') return makeJsonResponse(CATEGORIES);
        if (url === '/users') return makeJsonResponse(USERS);
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      render(<TicketsPage />);
      await screen.findByTestId('ticket-row-tk-healthy');
      // Wait for the options effect to settle (categories rendered).
      await screen.findByRole('option', { name: 'Hardware' });

      const allFetchUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(allFetchUrls.every((u) => !u.includes('/orgs/organizations'))).toBe(true);
      expect(screen.queryByTestId('tickets-filter-org')).toBeNull();
    });

    it('partner scope with one org returned: org filter hidden; with two orgs: visible', async () => {
      // First: one org returned
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/tickets/stats') return makeJsonResponse(STATS);
        if (url.startsWith('/tickets?')) return makeJsonResponse({ data: [healthy] });
        if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme Corp' }] });
        if (url === '/ticket-categories') return makeJsonResponse(CATEGORIES);
        if (url === '/users') return makeJsonResponse(USERS);
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      const { unmount } = render(<TicketsPage />);
      await screen.findByTestId('ticket-row-tk-healthy');
      // Options load asynchronously — wait for categories to confirm effect settled.
      await screen.findByRole('option', { name: 'Hardware' });

      expect(screen.queryByTestId('tickets-filter-org')).toBeNull();
      unmount();

      vi.clearAllMocks();
      capturedWorkbenchProps.length = 0;

      // Second: two orgs returned
      mockListApi([healthy]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      await screen.findByRole('option', { name: 'Globex' });

      expect(screen.getByTestId('tickets-filter-org')).toBeInTheDocument();
    });
  });

  describe('bulk outcome toasts', () => {
    it('partial result with skippedReasons shows a warning toast with counts and labels', async () => {
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/tickets/stats') return makeJsonResponse(STATS);
        if (url.startsWith('/tickets?')) return makeJsonResponse({ data: [healthy, atRisk] });
        if (url.startsWith('/orgs/organizations')) return makeJsonResponse(ORGS);
        if (url === '/ticket-categories') return makeJsonResponse(CATEGORIES);
        if (url === '/users') return makeJsonResponse(USERS);
        if (url === '/tickets/bulk') {
          return makeJsonResponse({ data: { updated: 0, skipped: 2, failed: 0, total: 2, skippedReasons: { OUT_OF_SCOPE: 1, INVALID_TRANSITION: 1 } } });
        }
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      render(<TicketsPage />);
      await screen.findByTestId('ticket-row-tk-healthy');

      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));
      fireEvent.change(screen.getByTestId('tickets-bulk-status'), { target: { value: 'closed' } });
      fireEvent.click(screen.getByTestId('tickets-bulk-apply'));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'warning',
            message: expect.stringContaining('0 updated')
          })
        );
      });
      const call = showToast.mock.calls[0]?.[0] as { type: string; message: string };
      expect(call.message).toContain('0 updated, 2 skipped');
      expect(call.message).toContain('out of your scope');
      expect(call.message).toContain('invalid status change');
      // No failures → the failed segment is omitted entirely.
      expect(call.message).not.toContain('failed');
    });

    it('failed writes are reported distinctly from skips in the warning toast', async () => {
      mockListApi([healthy, atRisk, breached], {
        bulkResult: { data: { updated: 1, skipped: 1, failed: 1, total: 3, skippedReasons: { OUT_OF_SCOPE: 1 } } } as typeof BULK_RESULT
      });

      render(<TicketsPage />);
      await screen.findByTestId('ticket-row-tk-healthy');

      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-breach'));
      fireEvent.change(screen.getByTestId('tickets-bulk-status'), { target: { value: 'closed' } });
      fireEvent.click(screen.getByTestId('tickets-bulk-apply'));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'warning', message: expect.stringContaining(', 1 failed') })
        );
      });
      const call = showToast.mock.calls[0]?.[0] as { type: string; message: string };
      expect(call.message).toContain('1 updated, 1 skipped, 1 failed');
      expect(call.message).toContain('out of your scope');
    });

    it('fully-successful bulk shows a success toast with updated count', async () => {
      // 3 selected, 3 updated — the toast count must come from the server response.
      mockListApi([healthy, atRisk, breached], { bulkResult: { data: { updated: 3, skipped: 0, failed: 0, total: 3 } } });
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-breach'));

      fireEvent.change(screen.getByTestId('tickets-bulk-status'), { target: { value: 'closed' } });
      fireEvent.click(screen.getByTestId('tickets-bulk-apply'));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith({ type: 'success', message: '3 updated' });
      });
    });
  });

  describe('pane refresh after bulk', () => {
    it('increments refreshToken on TicketWorkbench after a successful bulk apply', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      await waitFor(() => {
        expect(screen.getByTestId('ticket-workbench-mock')).toBeInTheDocument();
      });

      const tokenBefore = Number(screen.getByTestId('ticket-workbench-mock').getAttribute('data-refresh') ?? '0');

      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.change(screen.getByTestId('tickets-bulk-status'), { target: { value: 'closed' } });
      fireEvent.click(screen.getByTestId('tickets-bulk-apply'));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalled();
      });

      await waitFor(() => {
        const tokenAfter = Number(screen.getByTestId('ticket-workbench-mock').getAttribute('data-refresh') ?? '0');
        expect(tokenAfter).toBeGreaterThan(tokenBefore);
      });
    });
  });
});
