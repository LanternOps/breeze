import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TicketsPage from './TicketsPage';
import { fetchWithAuth } from '../../stores/auth';
import type { TicketSummary } from './ticketConfig';
import { resetTypingCadence } from '@/lib/keyboard/bareKeyGuard';

// Triage board, then focus: /tickets is a full-width queue; a ticket opens in
// place keyed by the hash (#T-…), and /tickets/[id] renders the same focus view.

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

vi.mock('../../lib/ticketConfigApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ticketConfigApi')>();
  return { ...actual, fetchTicketConfig: vi.fn().mockResolvedValue(null) };
});

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'p-1' }),
  loginPathWithNext: () => '/login?next=%2F'
}));

type WorkbenchProps = {
  ticketId: string;
  resolveToast?: boolean;
  onTicketPatched?: (id: string, patch: Partial<TicketSummary>) => void;
};
const workbenchProps: WorkbenchProps[] = [];
const lastWorkbench = () => workbenchProps[workbenchProps.length - 1];
vi.mock('./TicketWorkbench', () => ({
  default: (props: WorkbenchProps) => {
    workbenchProps.push(props);
    return (
      <div data-testid="ticket-workbench-mock">
        {props.ticketId}
        <textarea data-testid="ticket-composer-input" />
      </div>
    );
  }
}));
vi.mock('./InboundReviewQueue', () => ({ default: () => <div data-testid="inbound-review-queue-mock" /> }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const makeTicket = (o: Partial<TicketSummary> & { id: string }): TicketSummary => ({
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
  ...o
});

const one = makeTicket({ id: 'tk-1', internalNumber: 'T-1001', subject: 'Printer offline' });
const two = makeTicket({ id: 'tk-2', internalNumber: 'T-1002', subject: 'VPN drops', slaBreachedAt: minutesAgo(30) });
const three = makeTicket({ id: 'tk-3', internalNumber: 'T-1003', subject: 'New laptop' });
const LIST = [one, two, three];

function mockApi(list: TicketSummary[] | ((url: string) => TicketSummary[]) = LIST) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/tickets/stats') return json({ data: { open: 3, unassigned: 3, mine: 0, breached: 1 } });
    if (url.startsWith('/tickets?')) return json({ data: typeof list === 'function' ? list(url) : list });
    if (url === '/ticket-categories') return json({ data: [] });
    if (url === '/users') return json({ data: [] });
    if (url.startsWith('/ticket-config/email-inbound')) return json({ error: 'admin' }, false, 403);
    if (/^\/tickets\/[^/?]+$/.test(url)) {
      const id = url.split('/')[2];
      const found = LIST.find((t) => t.id === id);
      return found ? json({ data: found }) : json({ error: 'nf' }, false, 404);
    }
    return json({ error: 'unexpected' }, false, 404);
  });
}

const ticketListUrls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/tickets?'));
const press = (key: string, target: Element | Document = document.body) => {
  resetTypingCadence();
  fireEvent.keyDown(target, { key });
};

beforeEach(() => {
  vi.clearAllMocks();
  workbenchProps.length = 0;
  authState.permissions = [];
  history.replaceState(null, '', '/tickets');
  try { window.localStorage.clear(); } catch { /* storage unavailable */ }
});
afterEach(() => { history.replaceState(null, '', '/tickets'); });

describe('TicketsPage triage board', () => {
  it('with no hash renders the full-width triage queue and never auto-selects a ticket', async () => {
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');

    expect(screen.getByTestId('tickets-triage')).not.toHaveAttribute('hidden');
    expect(screen.queryByTestId('tickets-focus')).toBeNull();
    expect(screen.queryByTestId('ticket-workbench-mock')).toBeNull();
    // Nothing was picked for the user, and the URL stayed clean.
    expect(window.location.hash).toBe('');
    for (const id of ['tk-1', 'tk-2', 'tk-3']) {
      expect(screen.getByTestId(`ticket-row-${id}`)).toHaveAttribute('aria-selected', 'false');
    }
  });

  it('puts the search box on the filter row', async () => {
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');
    expect(within(screen.getByTestId('tickets-filter-bar')).getByTestId('tickets-search-input')).toBeInTheDocument();
  });

  it('j/k move the active row without opening it; Enter opens the active row in focus', async () => {
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');

    press('j');
    expect(screen.getByTestId('ticket-row-tk-1')).toHaveAttribute('aria-selected', 'true');
    press('j');
    expect(screen.getByTestId('ticket-row-tk-2')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByTestId('ticket-row-tk-2'));
    expect(screen.queryByTestId('ticket-workbench-mock')).toBeNull();
    expect(window.location.hash).toBe('');

    press('Enter');
    await waitFor(() => expect(window.location.hash).toBe('#T-1002'));
    expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-2');
  });
});

describe('TicketsPage focus mode', () => {
  it('clicking a row opens the ticket in place, keyed by the hash, and hides the board', async () => {
    mockApi();
    render(<TicketsPage />);
    fireEvent.click(await screen.findByTestId('ticket-row-tk-2'));

    await waitFor(() => expect(window.location.hash).toBe('#T-1002'));
    expect(window.location.pathname).toBe('/tickets');
    expect(screen.getByTestId('tickets-focus')).toBeInTheDocument();
    expect(screen.getByTestId('tickets-triage')).toHaveAttribute('hidden');
    expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-2');
    expect(screen.getByTestId('ticket-focus-back')).toHaveTextContent('All open');
    expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('2 of 3');
  });

  it('Esc goes back to the board, restoring the active row and its scroll position', async () => {
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');
    const scroller = screen.getByTestId('tickets-queue-scroll');
    scroller.scrollTop = 240;
    fireEvent.click(screen.getByTestId('ticket-row-tk-3'));
    await screen.findByTestId('tickets-focus');
    scroller.scrollTop = 0; // a hidden scroller can lose its offset

    press('Escape');

    await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
    expect(window.location.hash).toBe('');
    expect(screen.getByTestId('tickets-triage')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('ticket-row-tk-3')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ticket-row-tk-3')));
    expect(scroller.scrollTop).toBe(240);
  });

  it('Esc inside a text field only leaves the field; the next Esc goes back', async () => {
    window.location.hash = '#T-1001';
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('tickets-focus');
    const input = screen.getByTestId('ticket-composer-input');
    input.focus();

    press('Escape', input);
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByTestId('tickets-focus')).toBeInTheDocument();

    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
  });

  it('the back button returns to the board', async () => {
    window.location.hash = '#T-1001';
    mockApi();
    render(<TicketsPage />);
    fireEvent.click(await screen.findByTestId('ticket-focus-back'));
    await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
    expect(window.location.hash).toBe('');
  });

  it('j/k move between tickets in place and update "N of M"; prev/next buttons do the same', async () => {
    window.location.hash = '#T-1001';
    mockApi();
    render(<TicketsPage />);
    await waitFor(() => expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('1 of 3'));
    expect(screen.getByTestId('ticket-focus-prev')).toBeDisabled();

    press('j');
    await waitFor(() => expect(window.location.hash).toBe('#T-1002'));
    expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('2 of 3');
    expect(lastWorkbench().ticketId).toBe('tk-2');

    fireEvent.click(screen.getByTestId('ticket-focus-next'));
    await waitFor(() => expect(window.location.hash).toBe('#T-1003'));
    expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('3 of 3');
    expect(screen.getByTestId('ticket-focus-next')).toBeDisabled();

    press('k');
    await waitFor(() => expect(window.location.hash).toBe('#T-1002'));
    expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('2 of 3');
  });

  it('does not navigate to a full page at a narrow width: focus is in place at every width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    mockApi();
    render(<TicketsPage />);
    fireEvent.click(await screen.findByTestId('ticket-row-tk-1'));
    await waitFor(() => expect(window.location.hash).toBe('#T-1001'));
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-1');
  });
});

describe('TicketsPage /tickets/[id]', () => {
  it('renders the same focus view for the route id, with the stored queue tab as list context', async () => {
    window.localStorage.setItem('breeze.tickets.queueTab', 'unassigned');
    history.replaceState(null, '', '/tickets/tk-2');
    mockApi();
    render(<TicketsPage routeTicketId="tk-2" />);

    // The detail renders straight away for a uuid-style route id.
    expect(await screen.findByTestId('ticket-workbench-mock')).toHaveTextContent('tk-2');
    await waitFor(() => expect(ticketListUrls().at(-1)).toContain('assignee=unassigned'));
    expect(screen.getByTestId('ticket-focus-back')).toHaveTextContent('Unassigned');
    await waitFor(() => expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('2 of 3'));

    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
    expect(window.location.pathname).toBe('/tickets');
  });

  it('j from /tickets/[id] moves to the canonical /tickets#<number> URL', async () => {
    history.replaceState(null, '', '/tickets/tk-1');
    mockApi();
    render(<TicketsPage routeTicketId="tk-1" />);
    await waitFor(() => expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('1 of 3'));
    press('j');
    await waitFor(() => expect(window.location.pathname + window.location.hash).toBe('/tickets#T-1002'));
  });
});

describe('TicketsPage resolve → next offer', () => {
  it('offers the next ticket after a resolve, stays on the resolved one, and opens it on Enter', async () => {
    window.location.hash = '#T-1001';
    mockApi();
    render(<TicketsPage />);
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-1'));

    act(() => { lastWorkbench().onTicketPatched?.('tk-1', { status: 'resolved' }); });

    const offer = await screen.findByTestId('ticket-next-offer');
    // The strip says it; the focus view does not toast "Ticket resolved" too.
    expect(lastWorkbench().resolveToast).toBe(false);
    // One ruled band on the header's gutter.
    const band = screen.getByTestId('ticket-focus-notice-band');
    expect(band).toContainElement(offer);
    expect(band.className).toContain('px-4');
    expect(band.className).toContain('border-b');
    expect(offer).toHaveTextContent('T-1002');
    expect(offer).toHaveTextContent('VPN drops');
    expect(offer).toHaveTextContent('Breached');
    // Never auto-advance.
    expect(window.location.hash).toBe('#T-1001');
    expect(lastWorkbench().ticketId).toBe('tk-1');

    press('Enter');
    await waitFor(() => expect(window.location.hash).toBe('#T-1002'));
    expect(screen.queryByTestId('ticket-next-offer')).toBeNull();
  });

  it('opens the offered ticket on click', async () => {
    window.location.hash = '#T-1002';
    mockApi();
    render(<TicketsPage />);
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-2'));
    act(() => { lastWorkbench().onTicketPatched?.('tk-2', { status: 'resolved' }); });
    fireEvent.click(await screen.findByTestId('ticket-next-offer-open'));
    await waitFor(() => expect(window.location.hash).toBe('#T-1003'));
  });

  it('offers nothing for a non-closing change', async () => {
    window.location.hash = '#T-1001';
    mockApi();
    render(<TicketsPage />);
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-1'));
    act(() => { lastWorkbench().onTicketPatched?.('tk-1', { priority: 'high' }); });
    expect(screen.queryByTestId('ticket-next-offer')).toBeNull();
  });
});
