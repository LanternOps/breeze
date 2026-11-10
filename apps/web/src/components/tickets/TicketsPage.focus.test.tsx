import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  resolveToast?: boolean | ((ticketId: string) => boolean);
  composeRequest?: { mode: 'reply' | 'internal'; token: number };
  onTicketPatched?: (id: string, patch: Partial<TicketSummary>) => void;
  onChanged?: () => void;
  onReady?: (id: string) => void;
};
const workbenchProps: WorkbenchProps[] = [];
const lastWorkbench = () => workbenchProps[workbenchProps.length - 1];
// How many times the focus view's workbench mounted: a refetch that drops the
// open ticket from the list must never unmount it.
const workbenchMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('./TicketWorkbench', async () => {
  const { useEffect } = await import('react');
  return {
    default: (props: WorkbenchProps) => {
      workbenchProps.push(props);
      useEffect(() => { workbenchMounts.count += 1; }, []);
      // The real workbench reports ready once the ticket's detail has loaded.
      const { ticketId, onReady } = props;
      useEffect(() => { onReady?.(ticketId); }, [ticketId, onReady]);
      return (
        <div data-testid="ticket-workbench-mock">
          {props.ticketId}
          <h2 id="ticket-focus-subject" tabIndex={-1} data-testid="ticket-workbench-subject">Subject of {props.ticketId}</h2>
          <textarea data-testid="ticket-composer-input" />
        </div>
      );
    }
  };
});
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

function mockApi(
  list: TicketSummary[] | ((url: string) => TicketSummary[]) = LIST,
  route?: (url: string, init?: RequestInit) => Response | undefined,
) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const routed = route?.(url, init);
    if (routed) return routed;
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

const wantsResolveToast = (props: WorkbenchProps, id: string): boolean =>
  typeof props.resolveToast === 'function' ? props.resolveToast(id) : props.resolveToast ?? true;

const ticketListUrls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/tickets?'));
const press = (key: string, target: Element | Document = document.body) => {
  resetTypingCadence();
  fireEvent.keyDown(target, { key });
};

beforeEach(() => {
  vi.clearAllMocks();
  workbenchProps.length = 0;
  workbenchMounts.count = 0;
  authState.permissions = [];
  // A new entry, so no forward entries a previous test left behind (Back /
  // Forward below) can be reached from this one.
  history.pushState(null, '', '/tickets');
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

    // The strip will say it, so the focus view does not toast "Ticket resolved"
    // too (asked once the resolve lands, before the row is patched).
    expect(wantsResolveToast(lastWorkbench(), 'tk-1')).toBe(false);
    act(() => { lastWorkbench().onTicketPatched?.('tk-1', { status: 'resolved' }); });

    const offer = await screen.findByTestId('ticket-next-offer');
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

describe('TicketsPage resolve toast', () => {
  it('toasts the resolve when no next ticket is left to offer', async () => {
    window.location.hash = '#T-1001';
    mockApi([one]);
    render(<TicketsPage />);
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-1'));
    expect(wantsResolveToast(lastWorkbench(), 'tk-1')).toBe(true);
  });

  it('toasts a resolve of a ticket that was already closed (the Closed tab offers nothing)', async () => {
    const closedOne = makeTicket({ id: 'tk-9', internalNumber: 'T-1009', status: 'closed' });
    window.location.hash = '#T-1009';
    mockApi([closedOne, two]);
    render(<TicketsPage />);
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-9'));
    expect(wantsResolveToast(lastWorkbench(), 'tk-9')).toBe(true);
  });
});

describe('TicketsPage browser history', () => {
  // public/same-page-history.js, as every ClientRouter layout loads it: a
  // classic script, so its popstate listener is installed before the router's.
  beforeAll(() => {
    // Our own committed file read from disk: executes the shipped script under test.
    // eslint-disable-next-line no-new-func -- executes the trusted file under test
    new Function(readFileSync(join(process.cwd(), 'public/same-page-history.js'), 'utf8'))();
  });

  // Stands in for Astro's <ClientRouter /> popstate listener. Chromium runs
  // window listeners in registration order, capture or not, and the router's
  // is registered at module load, before any island's. Registering this one as
  // a capture listener before render gives that order under jsdom (which runs
  // capture listeners first). Like the router on a same-page step whose last
  // location carried no hash, it re-fetches and swaps the page: the island
  // remounts with fresh state.
  function renderWithRouter() {
    let generation = 0;
    let view: ReturnType<typeof render> | null = null;
    const pops: unknown[] = [];
    const router = (e: PopStateEvent) => {
      if (e.state === null) return; // the router ignores state-less entries
      pops.push(e.state);
      generation += 1;
      view?.rerender(<TicketsPage key={generation} />);
    };
    // Registered before the island renders, as the router is.
    window.addEventListener('popstate', router, true);
    view = render(<TicketsPage key={generation} />);
    return { pops, uninstall: () => window.removeEventListener('popstate', router, true) };
  }

  it('opening a ticket from the board pushes one entry, marked as the ticket opened from the board; j/k in focus replace it', async () => {
    history.replaceState({ index: 7, scrollX: 0, scrollY: 0 }, '', '/tickets');
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');
    const push = vi.spyOn(window.history, 'pushState');
    const before = window.history.length;
    try {
      fireEvent.click(screen.getByTestId('ticket-row-tk-1'));
      await waitFor(() => expect(window.location.hash).toBe('#T-1001'));
      expect(push).toHaveBeenCalledTimes(1);
      expect(window.history.length).toBe(before + 1);
      // Astro's router fields survive; the mark travels with the entry itself,
      // so Back / Forward / a remount cannot lose it.
      expect(window.history.state).toEqual({ index: 7, scrollX: 0, scrollY: 0, breezeTicketsFocus: true });

      press('j');
      await waitFor(() => expect(window.location.hash).toBe('#T-1002'));
      expect(push).toHaveBeenCalledTimes(1);
      expect(window.history.length).toBe(before + 1);
      expect(window.history.state).toEqual({ index: 7, scrollX: 0, scrollY: 0, breezeTicketsFocus: true });
    } finally {
      push.mockRestore();
    }
  });

  it('browser Back from focus restores the active row\'s keyboard focus and scroll position, as Esc does, without the router re-rendering the page', async () => {
    history.replaceState({ index: 3, scrollX: 0, scrollY: 0 }, '', '/tickets');
    mockApi();
    const router = renderWithRouter();
    try {
      await screen.findByTestId('ticket-row-tk-1');
      screen.getByTestId('tickets-queue-scroll').scrollTop = 240;
      fireEvent.click(screen.getByTestId('ticket-row-tk-2'));
      await screen.findByTestId('tickets-focus');
      press('j');
      await waitFor(() => expect(window.location.hash).toBe('#T-1003'));
      screen.getByTestId('tickets-queue-scroll').scrollTop = 0; // a hidden scroller can lose its offset

      history.back();

      await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
      expect(window.location.pathname + window.location.hash).toBe('/tickets');
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ticket-row-tk-3')));
      expect(screen.getByTestId('ticket-row-tk-3')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('tickets-queue-scroll').scrollTop).toBe(240);
      expect(router.pops).toEqual([]);
    } finally {
      router.uninstall();
    }
  });

  // The browser repro: open → j → Back → Forward → Esc → Back must leave
  // /tickets, so Esc after a Forward has to step back, not write the board
  // over the ticket's entry.
  it('after Back then Forward, Esc steps back through the pushed entry instead of replacing it', async () => {
    history.replaceState({ index: 3, scrollX: 0, scrollY: 0 }, '', '/tickets');
    mockApi();
    const router = renderWithRouter();
    try {
      fireEvent.click(await screen.findByTestId('ticket-row-tk-1'));
      await screen.findByTestId('tickets-focus');
      press('j');
      press('j');
      await waitFor(() => expect(window.location.hash).toBe('#T-1003'));

      history.back();
      await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
      history.forward();
      await waitFor(() => expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-3'));
      const length = window.history.length;

      const back = vi.spyOn(window.history, 'back');
      const replace = vi.spyOn(window.history, 'replaceState');
      try {
        press('Escape');
        expect(back).toHaveBeenCalledTimes(1);
        expect(replace).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
        expect(window.location.pathname + window.location.hash).toBe('/tickets');
        expect(window.history.length).toBe(length);
        expect(router.pops).toEqual([]);
      } finally {
        back.mockRestore();
        replace.mockRestore();
      }
    } finally {
      router.uninstall();
    }
  });

  it('Esc after opening from the board steps back through the pushed entry, so Forward reopens the ticket', async () => {
    mockApi();
    render(<TicketsPage />);
    fireEvent.click(await screen.findByTestId('ticket-row-tk-1'));
    await screen.findByTestId('tickets-focus');
    const length = window.history.length;

    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
    // No new entry: Esc went back rather than writing the board over the ticket.
    expect(window.history.length).toBe(length);

    history.forward();
    await waitFor(() => expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-1'));
  });

  it('Esc on a ticket that was not opened from the board (a deep link) writes the board in place', async () => {
    window.location.hash = '#T-1001';
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('tickets-focus');
    const back = vi.spyOn(window.history, 'back');
    try {
      press('Escape');
      await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
      expect(back).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');
    } finally {
      back.mockRestore();
    }
  });
});

describe('TicketsPage focus: keyboard focus and announcements', () => {
  it('opening from the board moves focus to the subject and announces the ticket outside the hidden board', async () => {
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');
    press('j');
    press('j');
    press('Enter');

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ticket-workbench-subject')));
    const announcer = screen.getByTestId('tickets-queue-announcer');
    expect(screen.getByTestId('tickets-triage')).toHaveAttribute('hidden');
    expect(screen.getByTestId('tickets-triage')).not.toContainElement(announcer);
    expect(announcer).toHaveTextContent('T-1002 VPN drops, Normal priority, SLA breached');
  });

  it('j/k in focus move focus to the new subject and announce the new ticket', async () => {
    mockApi();
    render(<TicketsPage />);
    fireEvent.click(await screen.findByTestId('ticket-row-tk-1'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ticket-workbench-subject')));
    // Focus leaves the heading (e.g. onto the page) before the next move.
    (document.activeElement as HTMLElement).blur();

    press('j');
    await waitFor(() => expect(lastWorkbench().ticketId).toBe('tk-2'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ticket-workbench-subject')));
    expect(screen.getByTestId('tickets-queue-announcer')).toHaveTextContent('T-1002 VPN drops, Normal priority, SLA breached');
  });

  it('a /tickets/[id] page load announces nothing and leaves focus where the page put it', async () => {
    history.replaceState(null, '', '/tickets/tk-2');
    mockApi();
    render(<TicketsPage routeTicketId="tk-2" />);
    expect(await screen.findByTestId('ticket-workbench-mock')).toHaveTextContent('tk-2');
    await waitFor(() => expect(screen.getByTestId('ticket-focus-position')).toHaveTextContent('2 of 3'));
    expect(screen.getByTestId('tickets-queue-announcer')).toHaveTextContent('');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('TicketsPage r / n reach the composer through the workbench', () => {
  it('in focus, r and n ask the workbench for the composer in that mode', async () => {
    window.location.hash = '#T-1001';
    mockApi();
    render(<TicketsPage />);
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-1'));

    press('n');
    expect(lastWorkbench().composeRequest).toEqual({ mode: 'internal', token: 1 });
    press('r');
    expect(lastWorkbench().composeRequest).toEqual({ mode: 'reply', token: 2 });
  });

  it('r from the board opens the active ticket, then asks for the composer once its detail is ready', async () => {
    mockApi();
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');
    press('j');
    press('r');
    await waitFor(() => expect(lastWorkbench()?.composeRequest).toEqual({ mode: 'reply', token: 1 }));
    expect(lastWorkbench().ticketId).toBe('tk-1');
  });
});

describe('TicketsPage keeps the open ticket when a refetch drops it from the view', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  // jsdom measures every tab at 0px, so OverflowTabs puts all but the first
  // behind "More" (see TicketsPage.test.tsx selectTicketsTab).
  const selectTab = async (id: string) => {
    let el = screen.queryByTestId(`tickets-tab-${id}`);
    if (!el || el.getAttribute('role') !== 'tab') {
      const more = screen.queryByTestId('tickets-tab-more');
      if (more && more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
      el = await screen.findByTestId(`tickets-tab-${id}`);
    }
    fireEvent.click(el);
  };

  it('on Unassigned, `a` assigns the open ticket; the refetch without it does not unmount the focus view', async () => {
    let assigned = false;
    mockApi(
      (url) => (url.includes('assignee=unassigned') && assigned ? [two, three] : LIST),
      (url, init) => {
        if (url === '/tickets/tk-1/assign' && init?.method === 'POST') {
          assigned = true;
          return json({ data: { id: 'tk-1' } });
        }
        return undefined;
      },
    );
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');
    await selectTab('unassigned');
    await waitFor(() => expect(ticketListUrls().at(-1)).toContain('assignee=unassigned'));
    fireEvent.click(await screen.findByTestId('ticket-row-tk-1'));
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-1'));
    const mounts = workbenchMounts.count;
    const lists = ticketListUrls().length;

    press('a');
    await waitFor(() => expect(assigned).toBe(true));
    await waitFor(() => expect(ticketListUrls().length).toBeGreaterThan(lists));
    await settle();

    expect(workbenchMounts.count).toBe(mounts);
    expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-1');
    expect(screen.getByTestId('tickets-left-view')).toHaveTextContent('Ticket T-1001 is not in this view.');
  });

  it('on Breaching, a first reply that takes the ticket off the tab does not unmount the focus view', async () => {
    let replied = false;
    mockApi((url) => (url.includes('slaState=breaching') ? (replied ? [three] : [two, three]) : LIST));
    render(<TicketsPage />);
    await screen.findByTestId('ticket-row-tk-1');
    await selectTab('breaching');
    fireEvent.click(await screen.findByTestId('ticket-row-tk-2'));
    await waitFor(() => expect(lastWorkbench()?.ticketId).toBe('tk-2'));
    const mounts = workbenchMounts.count;
    const lists = ticketListUrls().length;

    // sendComment reconciles without a row patch (firstResponseAt is stamped server-side).
    replied = true;
    act(() => { lastWorkbench().onChanged?.(); });
    await waitFor(() => expect(ticketListUrls().length).toBeGreaterThan(lists));
    await settle();

    expect(workbenchMounts.count).toBe(mounts);
    expect(screen.getByTestId('ticket-workbench-mock')).toHaveTextContent('tk-2');
  });
});

describe('TicketsPage back on the board', () => {
  it('scrolls the active row into view after many j/k in focus', async () => {
    const original = Element.prototype.scrollIntoView;
    const scrolled: Array<{ el: Element; arg: unknown }> = [];
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolled.push({ el: this, arg }); };
    try {
      mockApi();
      render(<TicketsPage />);
      fireEvent.click(await screen.findByTestId('ticket-row-tk-1'));
      await screen.findByTestId('tickets-focus');
      press('j');
      press('j');
      await waitFor(() => expect(window.location.hash).toBe('#T-1003'));

      press('Escape');
      await waitFor(() => expect(screen.queryByTestId('tickets-focus')).toBeNull());
      await waitFor(() => expect(scrolled.some(({ el, arg }) => el === screen.getByTestId('ticket-row-tk-3') && (arg as { block?: string })?.block === 'nearest')).toBe(true));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
