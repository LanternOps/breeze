import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketsPage from './TicketsPage';
import { fetchWithAuth } from '../../stores/auth';
import { fetchTicketConfig, type TicketConfig } from '../../lib/ticketConfigApi';
import type { TicketSummary } from './ticketConfig';

// Mutable grant set the mocked auth store reads from. usePermissions() reads
// `user.permissions` via the selector form; assignMe reads `getState().user.id`.
type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [] as Perm[] }));
const userState = () => ({ id: 'user-1', permissions: authState.permissions });
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector?: (s: { user: ReturnType<typeof userState> }) => unknown) => {
      const s = { user: userState() };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ user: userState() }) }
  )
}));

// Stub fetchTicketConfig; real display helpers (statusLabel/priorityLabel) run unchanged.
vi.mock('../../lib/ticketConfigApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ticketConfigApi')>();
  return { ...actual, fetchTicketConfig: vi.fn().mockResolvedValue(null) };
});
const fetchConfigMock = vi.mocked(fetchTicketConfig);

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

// The review-queue surface has its own suite (InboundReviewQueue.test.tsx); here
// we only verify the tab gating/badge and that selecting it swaps in the pane.
const capturedReviewProps: Array<{ onTotalChange?: (n: number) => void }> = [];
vi.mock('./InboundReviewQueue', () => ({
  default: (props: { onTotalChange?: (n: number) => void }) => {
    capturedReviewProps.push(props);
    return <div data-testid="inbound-review-queue-mock" />;
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
  opts: { usersFail?: boolean; bulkResult?: typeof BULK_RESULT; stats?: unknown; reviewTotal?: number } = {}
) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/tickets/stats') return makeJsonResponse(opts.stats ?? STATS);
    if (url === '/tickets/bulk') return makeJsonResponse(opts.bulkResult ?? BULK_RESULT);
    if (url.startsWith('/tickets/') && url.endsWith('/restore')) return makeJsonResponse({ data: { id: url.split('/')[2] } });
    if (url.startsWith('/tickets?')) return makeJsonResponse({ data: typeof tickets === 'function' ? tickets(url) : tickets });
    if (url.startsWith('/orgs/organizations')) return makeJsonResponse(ORGS);
    if (url === '/ticket-categories') return makeJsonResponse(CATEGORIES);
    // The inbound review-queue probe. Default: 403 (non-admin) so the tab stays
    // hidden, matching the bulk of these tests. opts.reviewTotal opts it in.
    if (url.startsWith('/ticket-config/email-inbound')) {
      return opts.reviewTotal === undefined
        ? makeJsonResponse({ error: 'admin' }, false, 403)
        : makeJsonResponse({ data: [], pagination: { page: 1, limit: 1, total: opts.reviewTotal } });
    }
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
    // Default: no manage grant → delete/archived controls hidden. Manage tests opt in.
    authState.permissions = [];
    // Default to partner scope so existing tests behave as before.
    mockGetJwtClaims.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p-1' });
    fetchConfigMock.mockResolvedValue(null);
    // jsdom defaults to 1024, which is below the 1100px split-pane breakpoint;
    // select() would navigate to the full page instead of selecting in-pane.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  });

  it('breaching tab requests slaState=breaching from the API', async () => {
    // The server owns the breaching definition (breached ∪ at-risk, pause-aware).
    // Returning the healthy row from the slaState=breaching request proves the
    // client renders rows as-is, with no client-side slaState filtering.
    mockListApi((url) => (url.includes('slaState=breaching') ? [healthy, atRisk, breached] : [healthy]));
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');

    fireEvent.click(screen.getByTestId('tickets-tab-breaching'));

    await waitFor(() => {
      expect(ticketFetchUrls().at(-1)).toContain('slaState=breaching');
    });
    expect(ticketFetchUrls().at(-1)).toContain('statusGroup=open');

    await screen.findByTestId('ticket-row-tk-risk');
    expect(screen.getByTestId('ticket-row-tk-breach')).toBeInTheDocument();
    // Server-returned rows render unfiltered — the old client-side slaState() filter is gone.
    expect(screen.getByTestId('ticket-row-tk-healthy')).toBeInTheDocument();
  });

  it('breaching tab badge shows breached + atRisk from /tickets/stats', async () => {
    mockListApi([healthy], { stats: { data: { open: 3, unassigned: 1, mine: 0, breached: 2, atRisk: 3 } } });
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');

    await waitFor(() => {
      expect(screen.getByTestId('tickets-tab-breaching')).toHaveTextContent('5');
    });
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

  it('renders no page-local org filter — org scoping belongs to the header switcher', async () => {
    mockListApi([healthy]);
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');
    // Wait for the filter-options effect to settle (categories rendered).
    await screen.findByRole('option', { name: 'Hardware' });

    expect(screen.queryByTestId('tickets-filter-org')).toBeNull();
    // No list requests carry a page-chosen orgId (the header's context is
    // injected by fetchWithAuth, not by this page).
    expect(ticketFetchUrls().every((u) => !u.includes('orgId='))).toBe(true);
  });

  it('hides the assignee select when the users request fails', async () => {
    mockListApi([healthy], { usersFail: true });
    render(<TicketsPage />);

    await screen.findByTestId('ticket-row-tk-healthy');
    // Other selects load their options; assignee stays hidden.
    await screen.findByRole('option', { name: 'Hardware' });
    expect(screen.queryByTestId('tickets-filter-assignee')).toBeNull();
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

  describe('queue sort control', () => {
    it('sort select passes sort=newest to the API and persists in the location hash', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      // Auto-select writes the selection hash first; sort must coexist with it.
      await waitFor(() => {
        expect(window.location.hash).toContain('T-2026-0001');
      });

      fireEvent.change(screen.getByTestId('ticket-sort'), { target: { value: 'newest' } });

      await waitFor(() => {
        expect(ticketFetchUrls().at(-1)).toContain('sort=newest');
      });
      expect(window.location.hash).toContain('sort=newest');
      expect(window.location.hash).toContain('T-2026-0001');
    });

    it('restores sort and selection from a combined hash on load', async () => {
      window.location.hash = '#T-2026-0002&sort=oldest';
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-risk');

      // SSR-safe hash adoption (#2421): the first render uses the 'triage'
      // default, then useHashState adopts the hash pre-paint and the list
      // effect refetches with sort=oldest (fetchSeq drops the stale response).
      // Assert on the fetch that wins, not the seed fetch.
      await waitFor(() => {
        expect(ticketFetchUrls().at(-1)).toContain('sort=oldest');
      });
      expect(screen.getByTestId('ticket-sort')).toHaveValue('oldest');
      await waitFor(() => {
        expect(screen.getByTestId('ticket-row-tk-risk')).toHaveAttribute('aria-selected', 'true');
      });
    });

    it('defaults to triage and omits the sort param (server default order)', async () => {
      mockListApi([healthy]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');

      expect(screen.getByTestId('ticket-sort')).toHaveValue('triage');
      expect(ticketFetchUrls().at(0)).not.toContain('sort=');
    });
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

    it('keeps selections when switching tabs (count includes off-view rows)', async () => {
      // The unassigned tab returns a list that excludes both selected rows —
      // the selection (and its count) must survive anyway: POST /tickets/bulk
      // takes raw ids and doesn't care about tabs.
      mockListApi((url) => (url.includes('assignee=unassigned') ? [breached] : [healthy, atRisk, breached]));
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));
      expect(screen.getByTestId('tickets-bulk-bar')).toHaveTextContent('2 selected');

      fireEvent.click(screen.getByTestId('tickets-tab-unassigned'));

      await waitFor(() => {
        expect(screen.queryByTestId('ticket-row-tk-healthy')).toBeNull();
      });
      // Both selected rows are off-view now; the bar still reports them.
      expect(screen.getByTestId('tickets-bulk-bar')).toHaveTextContent('2 selected');
    });

    it('clears selections when filters change', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      expect(screen.getByTestId('tickets-bulk-bar')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('tickets-filter-priority'), { target: { value: 'high' } });

      await waitFor(() => {
        expect(screen.queryByTestId('tickets-bulk-bar')).toBeNull();
      });
    });

    it('Clear empties a cross-tab selection spanning hidden rows', async () => {
      mockListApi((url) => (url.includes('assignee=unassigned') ? [breached] : [healthy, atRisk, breached]));
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));

      fireEvent.click(screen.getByTestId('tickets-tab-unassigned'));
      await waitFor(() => {
        expect(screen.queryByTestId('ticket-row-tk-healthy')).toBeNull();
      });
      expect(screen.getByTestId('tickets-bulk-bar')).toHaveTextContent('2 selected');

      fireEvent.click(screen.getByTestId('tickets-bulk-clear'));
      await waitFor(() => {
        expect(screen.queryByTestId('tickets-bulk-bar')).toBeNull();
      });
    });

    it('Select all adds the visible rows without dropping off-view selections', async () => {
      mockListApi((url) => (url.includes('assignee=unassigned') ? [breached] : [healthy, atRisk]));
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));

      fireEvent.click(screen.getByTestId('tickets-tab-unassigned'));
      await screen.findByTestId('ticket-row-tk-breach');

      fireEvent.click(screen.getByTestId('tickets-bulk-select-all'));
      // 2 off-view (open tab) + 1 visible = 3, not a replace-with-visible.
      expect(screen.getByTestId('tickets-bulk-bar')).toHaveTextContent('3 selected');
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

    it('header select-all is reachable with zero selections and selects all visible rows', async () => {
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      // Confirm no bulk bar at zero selections.
      expect(screen.queryByTestId('tickets-bulk-bar')).toBeNull();

      // The header affordance must be present without any prior selection.
      const headerSelectAll = screen.getByTestId('tickets-select-all-header');
      expect(headerSelectAll).toBeInTheDocument();

      fireEvent.click(headerSelectAll);

      // All 3 visible rows should be selected and the bulk bar shows the count.
      expect(screen.getByTestId('tickets-bulk-bar')).toHaveTextContent('3 selected');
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

  describe('search debounce', () => {
    it('coalesces rapid keystrokes — the intermediate value never hits the network', async () => {
      mockListApi([healthy]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      const before = ticketFetchUrls().length;

      // Two changes within one tick (far inside the debounce window).
      fireEvent.change(screen.getByTestId('tickets-search-input'), { target: { value: 'p' } });
      fireEvent.change(screen.getByTestId('tickets-search-input'), { target: { value: 'pr' } });

      // The final value fetches once the debounce settles…
      await waitFor(() => {
        expect(ticketFetchUrls().some((u) => u.includes('search=pr'))).toBe(true);
      });
      // …and the intermediate "p" was coalesced away (would fire per-keystroke without debounce).
      expect(ticketFetchUrls().filter((u) => /[?&]search=p(&|$)/.test(u))).toHaveLength(0);
      // Exactly one extra list fetch resulted from the burst (not two).
      expect(ticketFetchUrls().length - before).toBe(1);
    });
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

    it('partner scope: no /orgs/organizations fetch and no org filter (header owns org scoping)', async () => {
      mockListApi([healthy]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      await screen.findByRole('option', { name: 'Hardware' });

      const allFetchUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(allFetchUrls.every((u) => !u.includes('/orgs/organizations'))).toBe(true);
      expect(screen.queryByTestId('tickets-filter-org')).toBeNull();
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

  describe('custom-status queue chips', () => {
    const CONFIG: TicketConfig = {
      statuses: [
        { id: 'st-open', name: 'Open', coreStatus: 'open', color: null, sortOrder: 0, isSystem: true, isActive: true },
        { id: 'st-waiting', name: 'Waiting on customer', coreStatus: 'pending', color: '#ffaa00', sortOrder: 1, isSystem: false, isActive: true }
      ],
      priorities: {
        urgent: { label: 'Urgent', responseSlaMinutes: null, resolutionSlaMinutes: null },
        high: { label: 'High', responseSlaMinutes: null, resolutionSlaMinutes: null },
        normal: { label: 'Normal', responseSlaMinutes: null, resolutionSlaMinutes: null },
        low: { label: 'Low', responseSlaMinutes: null, resolutionSlaMinutes: null }
      }
    };

    it('row chip prefers statusName over the core label and shows the color dot', async () => {
      fetchConfigMock.mockResolvedValue(CONFIG);
      const custom = makeTicket({
        id: 'tk-custom',
        internalNumber: 'T-2026-0009',
        subject: 'Custom status ticket',
        status: 'pending',
        statusName: 'Waiting on customer',
        statusColor: '#ffaa00'
      });
      mockListApi([custom]);
      render(<TicketsPage />);

      const row = await screen.findByTestId('ticket-row-tk-custom');
      await waitFor(() => {
        expect(row).toHaveTextContent('Waiting on customer');
      });
      // Core label is replaced, not appended.
      expect(row).not.toHaveTextContent('Pending');
      // The color dot renders an inline style accent.
      const dot = row.querySelector('span[style*="background"]');
      expect(dot).not.toBeNull();
    });

    it('falls back to the core label when statusName is null', async () => {
      fetchConfigMock.mockResolvedValue(CONFIG);
      const legacy = makeTicket({ id: 'tk-legacy', internalNumber: 'T-2026-0010', status: 'open', statusName: null });
      mockListApi([legacy]);
      render(<TicketsPage />);

      const row = await screen.findByTestId('ticket-row-tk-legacy');
      await waitFor(() => {
        expect(row).toHaveTextContent('Open');
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

  describe('inbound review queue tab', () => {
    it('hides the Review queue tab when the queue probe is forbidden (non-admin)', async () => {
      mockListApi([healthy]); // default: probe 403s
      render(<TicketsPage />);
      await screen.findByTestId('ticket-row-tk-healthy');
      // Give the probe a tick to resolve before asserting absence.
      await waitFor(() => expect(screen.getByTestId('tickets-tab-open')).toBeInTheDocument());
      expect(screen.queryByTestId('tickets-tab-review')).toBeNull();
    });

    it('shows the Review queue tab with a pending-count badge when the probe succeeds', async () => {
      mockListApi([healthy], { reviewTotal: 3 });
      render(<TicketsPage />);
      await screen.findByTestId('ticket-row-tk-healthy');
      await screen.findByTestId('tickets-tab-review');
      expect(screen.getByTestId('tickets-tab-review-badge')).toHaveTextContent('3');
    });

    it('omits the badge when there is nothing pending', async () => {
      mockListApi([healthy], { reviewTotal: 0 });
      render(<TicketsPage />);
      await screen.findByTestId('tickets-tab-review');
      expect(screen.queryByTestId('tickets-tab-review-badge')).toBeNull();
    });

    it('selecting the Review queue tab swaps in the review pane and hides the ticket filters', async () => {
      mockListApi([healthy], { reviewTotal: 2 });
      render(<TicketsPage />);
      await screen.findByTestId('ticket-row-tk-healthy');

      fireEvent.click(await screen.findByTestId('tickets-tab-review'));

      await screen.findByTestId('tickets-review-pane');
      expect(screen.getByTestId('inbound-review-queue-mock')).toBeInTheDocument();
      // The ticket filter bar and queue list are not rendered on the review tab.
      expect(screen.queryByTestId('tickets-filter-bar')).toBeNull();
      expect(screen.queryByTestId('ticket-row-tk-healthy')).toBeNull();
    });
  });

  describe('soft-delete + archived (tickets:manage)', () => {
    const grantManage = () => { authState.permissions = [{ resource: 'tickets', action: 'manage' }]; };

    it('hides the Archived tab and the bulk Delete button without tickets:manage', async () => {
      mockListApi([healthy, atRisk]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      expect(screen.queryByTestId('tickets-tab-archived')).toBeNull();

      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      // Bulk bar is present, but the Delete affordance is manage-gated.
      expect(screen.getByTestId('tickets-bulk-bar')).toBeInTheDocument();
      expect(screen.queryByTestId('tickets-bulk-delete')).toBeNull();
    });

    it('shows the Archived tab and bulk Delete for a manager', async () => {
      grantManage();
      mockListApi([healthy, atRisk]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      expect(screen.getByTestId('tickets-tab-archived')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      expect(screen.getByTestId('tickets-bulk-delete')).toBeInTheDocument();
    });

    it('bulk delete confirms first, then POSTs action=delete and clears the bar', async () => {
      grantManage();
      mockListApi([healthy, atRisk, breached]);
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('ticket-select-tk-healthy'));
      fireEvent.click(screen.getByTestId('ticket-select-tk-risk'));

      // Clicking Delete opens the confirm dialog — no request yet.
      fireEvent.click(screen.getByTestId('tickets-bulk-delete'));
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/tickets/bulk')).toBe(false);

      fireEvent.click(await screen.findByTestId('tickets-bulk-delete-confirm'));

      await waitFor(() => {
        const bulkCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/tickets/bulk');
        expect(bulkCall).toBeTruthy();
        const body = JSON.parse(String((bulkCall![1] as RequestInit).body));
        expect(body).toEqual({ ticketIds: expect.arrayContaining(['tk-healthy', 'tk-risk']), action: 'delete' });
        expect(body.ticketIds).toHaveLength(2);
      });

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith({ type: 'success', message: '2 deleted' });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('tickets-bulk-bar')).toBeNull();
      });
    });

    it('Archived tab fetches ?deleted=only and restores a row', async () => {
      grantManage();
      const archived = makeTicket({ id: 'tk-arch', internalNumber: 'T-2026-0100', subject: 'Deleted ticket', deletedAt: minutesAgo(60 * 24 * 3) });
      mockListApi((url) => (url.includes('deleted=only') ? [archived] : [healthy]));
      render(<TicketsPage />);

      await screen.findByTestId('ticket-row-tk-healthy');
      fireEvent.click(screen.getByTestId('tickets-tab-archived'));

      await waitFor(() => {
        expect(ticketFetchUrls().at(-1)).toContain('deleted=only');
      });
      const row = await screen.findByTestId('ticket-archived-row-tk-arch');
      expect(row).toHaveTextContent('deleted 3d ago');
      // No workbench on the archived tab.
      expect(screen.queryByTestId('ticket-workbench-mock')).toBeNull();

      fireEvent.click(screen.getByTestId('ticket-restore-tk-arch'));

      await waitFor(() => {
        const restoreCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/tickets/tk-arch/restore');
        expect(restoreCall).toBeTruthy();
        expect((restoreCall![1] as RequestInit).method).toBe('POST');
      });
      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Ticket restored' });
      });
    });
  });
});
