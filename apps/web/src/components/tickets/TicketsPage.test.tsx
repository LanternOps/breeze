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

// Keep the page test focused on the queue: the workbench fetch/load cycle has its own suite.
vi.mock('./TicketWorkbench', () => ({
  default: ({ ticketId }: { ticketId: string }) => <div data-testid="ticket-workbench-mock">{ticketId}</div>
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

function mockListApi(tickets: TicketSummary[]) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/tickets/stats') return makeJsonResponse(STATS);
    if (url.startsWith('/tickets?')) return makeJsonResponse({ data: tickets });
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

function clearHash() {
  history.replaceState(null, '', window.location.pathname);
}

describe('TicketsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHash();
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
});
