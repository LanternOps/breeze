import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuotesPage from './QuotesPage';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload), blob: vi.fn() }) as unknown as Response;

const ORGS = [{ id: 'org-1', name: 'Acme Corp' }];
const QUOTES = [
  {
    id: 'q-1', quoteNumber: 'Q-0001', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null, taxTotal: '0.00',
    total: '150.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '50.00', annualRecurringTotal: '0.00',
    billToName: null, introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null, convertedAt: null,
    convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
];

describe('QuotesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renders the empty state without crashing', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: [] });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-empty')).toBeInTheDocument());
    expect(screen.getByText('No quotes yet')).toBeInTheDocument();
  });

  it('shows the filtered-empty state (not the teaching empty) when an active filter returns nothing', async () => {
    // The page seeds its filter from the URL hash on mount.
    window.location.hash = '#status=declined';
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: [] });
      return json({}, false, 404);
    });
    render(<QuotesPage />);

    await screen.findByTestId('quotes-filtered-empty');
    expect(screen.getByTestId('quotes-clear-filters')).toBeInTheDocument();
    // The first-run teaching empty must NOT be shown — that reads as data loss.
    expect(screen.queryByTestId('quotes-empty')).not.toBeInTheDocument();
  });

  it('Clear filters resets the hash with no bare-# residue', async () => {
    window.location.hash = '#status=declined';
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: [] });
      return json({}, false, 404);
    });
    render(<QuotesPage />);

    fireEvent.click(await screen.findByTestId('quotes-clear-filters'));
    expect(window.location.hash).toBe('');
    // With no active filter left, the teaching empty returns.
    await waitFor(() => expect(screen.getByTestId('quotes-empty')).toBeInTheDocument());
  });

  it('labels a single-currency Out-for-signature total from the AWAITING subset, not quotes[0]', async () => {
    // quotes[0] is a draft EUR quote (excluded from the sent/viewed subset); the
    // only awaiting quote is USD. The strip must read $…, never €… — labeling
    // the USD sum with quotes[0]'s currency was the original mislabeling bug.
    const mixed = [
      { ...QUOTES[0], id: 'q-eur-draft', quoteNumber: 'Q-EUR', status: 'draft', currencyCode: 'EUR', total: '999.00' },
      { ...QUOTES[0], id: 'q-usd-sent', quoteNumber: 'Q-USD', status: 'sent', currencyCode: 'USD', total: '150.00' },
    ];
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: mixed });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-outstanding-strip')).toBeInTheDocument());

    const strip = screen.getByTestId('quotes-outstanding-strip');
    expect(strip).toHaveTextContent('$150.00');
    expect(strip.textContent).not.toContain('€');
  });

  it('renders quote rows with status badge and currency total', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: QUOTES });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-table')).toBeInTheDocument());

    const row = screen.getByTestId('quotes-row-q-1');
    expect(within(row).getByText('Q-0001')).toBeInTheDocument();
    expect(within(row).getByText('Acme Corp')).toBeInTheDocument();
    expect(within(row).getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByTestId('quotes-status-q-1')).toHaveTextContent('Draft');
  });

  it('exposes a focusable link to the quote detail so keyboard users can open it', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: QUOTES });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-table')).toBeInTheDocument());

    const link = screen.getByTestId('quotes-row-link-q-1');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/billing/quotes/q-1');
    expect(link).toHaveTextContent('Q-0001');
    // A native anchor is focusable; it must never be removed from the tab order.
    expect(link.getAttribute('tabindex')).not.toBe('-1');

    // Clicking the link must not double-navigate via the row's onClick handler.
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    // Cancel the anchor's default action up front so jsdom doesn't attempt a real
    // document navigation (unimplemented → console noise). Propagation behavior
    // — the thing under test — is unaffected.
    clickEvent.preventDefault();
    const stop = vi.spyOn(clickEvent, 'stopPropagation');
    link.dispatchEvent(clickEvent);
    expect(stop).toHaveBeenCalled();
    // The row's onClick (SPA navigateTo) must not fire — the anchor navigates natively.
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('unnumbered draft rows show an em-dash link (no redundant DRAFT chip) with an accessible name', async () => {
    const draft = { ...QUOTES[0], id: 'q-draft', quoteNumber: null };
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: [draft] });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-table')).toBeInTheDocument());

    const link = screen.getByTestId('quotes-row-link-q-draft');
    // The Status column already carries the Draft pill, so the Number column shows
    // a plain em-dash rather than a second "DRAFT" chip…
    expect(link).toHaveTextContent('—');
    expect(within(link).queryByText('Draft')).not.toBeInTheDocument();
    // …but the link keeps an accessible name so it doesn't read as just a dash.
    expect(link).toHaveAttribute('aria-label', 'Draft quote');
    // The Status column still communicates draft state.
    expect(screen.getByTestId('quotes-status-q-draft')).toHaveTextContent('Draft');
  });

  it('the row Duplicate action clones the quote and lands in the new draft', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input === '/quotes/q-1/clone') return json({ data: { id: 'q-new' } });
      if (input.startsWith('/quotes')) return json({ data: QUOTES });
      void init;
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quotes-duplicate-q-1'));

    // The whole point of duplicating is to edit the new draft immediately.
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/quotes/q-new'));
    const cloneCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/quotes/q-1/clone');
    expect(cloneCall).toBeTruthy();
    expect((cloneCall![1] as RequestInit).method).toBe('POST');
  });

  it('create dialog with a "start from" source makes confirm CLONE the source, not create blank', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/orgs/sites')) return json({ data: [] });
      if (input === '/quotes/q-1/clone') return json({ data: { id: 'q-cloned' } });
      if (input === '/quotes' && init?.method === 'POST') return json({ data: { id: 'q-created' } });
      if (input.startsWith('/quotes')) return json({ data: QUOTES });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quotes-create-open'));
    fireEvent.change(await screen.findByTestId('quotes-create-org'), { target: { value: 'org-1' } });
    fireEvent.change(screen.getByTestId('quotes-create-source'), { target: { value: 'q-1' } });
    fireEvent.click(screen.getByTestId('quotes-create-submit'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/quotes/q-cloned'));
    const cloneCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/quotes/q-1/clone');
    expect(cloneCall).toBeTruthy();
    expect((cloneCall![1] as RequestInit).method).toBe('POST');
    // Retargeted to the chosen org; blank title omitted (fall back to source).
    expect(JSON.parse((cloneCall![1] as RequestInit).body as string)).toEqual({ orgId: 'org-1' });
    // The blank-create endpoint must NOT have been hit.
    expect(fetchMock.mock.calls.some(
      (c) => String(c[0]) === '/quotes' && (c[1] as RequestInit | undefined)?.method === 'POST',
    )).toBe(false);
  });

  it('create dialog without a source calls createQuote (no clone)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/orgs/sites')) return json({ data: [] });
      if (input === '/quotes' && init?.method === 'POST') return json({ data: { id: 'q-created' } });
      if (input.startsWith('/quotes')) return json({ data: QUOTES });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quotes-create-open'));
    fireEvent.change(await screen.findByTestId('quotes-create-org'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByTestId('quotes-create-submit'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/quotes/q-created'));
    const createCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/quotes' && (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({ orgId: 'org-1', currencyCode: 'USD' });
    // No clone endpoint involved in a blank create.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/clone'))).toBe(false);
  });

  it('renders the access-denied state (not the retryable error) on a 403', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ error: 'forbidden' }, false, 403);
      return json({}, false, 404);
    });
    render(<QuotesPage />);

    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument());
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to view quotes.")).toBeInTheDocument();
    // The generic data-load-failure UI must NOT appear for a 403.
    expect(screen.queryByTestId('quotes-error')).not.toBeInTheDocument();
    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
  });
});
