import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoicesPage from './InvoicesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
  // usePermissions() (billing-RBAC UI gating) reads grants off the store; grant
  // the admin wildcard so every gated control renders and these tests exercise
  // full functionality.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload), blob: vi.fn() }) as unknown as Response;

const ORGS = [{ id: 'org-1', name: 'Acme Corp' }, { id: 'org-2', name: 'Globex' }];
const INVOICES = [
  {
    id: 'inv-1', invoiceNumber: 'INV-0001', orgId: 'org-1', siteId: null, status: 'overdue',
    currencyCode: 'USD', issueDate: '2026-05-01', dueDate: '2026-05-31', sentAt: null, subtotal: '100.00',
    taxRate: '0.000', taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00',
    billToName: 'Acme', notes: null, termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-05-01T00:00:00Z',
  },
  {
    id: 'inv-2', invoiceNumber: null, orgId: 'org-2', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '0.00',
    taxRate: null, taxTotal: '0.00', total: '0.00', amountPaid: '0.00', balance: '0.00',
    billToName: null, notes: null, termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
  },
];

function wireDefault() {
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
    if (input.startsWith('/invoices')) return json({ data: INVOICES });
    if (input.startsWith('/orgs/sites')) return json({ data: [] });
    return json({}, false, 404);
  });
}

describe('InvoicesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renders invoice rows with status badge and currency totals', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    const row = screen.getByTestId('invoices-row-inv-1');
    expect(within(row).getByText('INV-0001')).toBeInTheDocument();
    expect(within(row).getByText('Acme Corp')).toBeInTheDocument();
    // Total + balance both render $100.00 in this row.
    expect(within(row).getAllByText('$100.00')).toHaveLength(2);
    // Overdue badge label + restrained overdue cue (red dot indicator + due tone),
    // replacing the old full-row red tint.
    expect(screen.getByTestId('invoices-status-inv-1')).toHaveTextContent('Overdue');
    expect(row.querySelector('.bg-destructive')).not.toBeNull();
  });

  it('exposes a focusable link to the invoice detail (desktop table + mobile card)', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    const link = screen.getByTestId('invoices-row-link-inv-1');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/billing/invoices/inv-1');
    expect(link).toHaveTextContent('INV-0001');
    expect(link.getAttribute('tabindex')).not.toBe('-1');

    const cardLink = screen.getByTestId('invoices-card-link-inv-1');
    expect(cardLink.tagName).toBe('A');
    expect(cardLink).toHaveAttribute('href', '/billing/invoices/inv-1');

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
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    // inv-2 has invoiceNumber === null. The Status column already carries the Draft
    // pill, so the Number column shows a plain em-dash rather than a second chip…
    const link = screen.getByTestId('invoices-row-link-inv-2');
    expect(link).toHaveTextContent('—');
    expect(within(link).queryByText('Draft')).not.toBeInTheDocument();
    // …but the link keeps an accessible name so it doesn't read as just a dash.
    expect(link).toHaveAttribute('aria-label', 'Draft invoice');
    // The Status column still communicates draft state.
    expect(screen.getByTestId('invoices-status-inv-2')).toHaveTextContent('Draft');
  });

  it('mobile card mirrors the em-dash draft link and its accessible name', async () => {
    // The stacked mobile card renders its own `invoices-card-link-*` anchor with
    // the same unnumbered-draft treatment as the desktop row — assert it here so
    // the two surfaces can't drift.
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    const cardLink = screen.getByTestId('invoices-card-link-inv-2');
    expect(cardLink.tagName).toBe('A');
    expect(cardLink).toHaveAttribute('href', '/billing/invoices/inv-2');
    expect(cardLink).toHaveTextContent('—');
    expect(within(cardLink).queryByText('Draft')).not.toBeInTheDocument();
    expect(cardLink).toHaveAttribute('aria-label', 'Draft invoice');
    // A numbered invoice's card link carries NO draft aria-label (its number is
    // its accessible name).
    expect(screen.getByTestId('invoices-card-link-inv-1')).not.toHaveAttribute('aria-label');
  });

  it('writes filter selections to the URL hash (no org filter — the header switcher owns org scoping)', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('invoices-filter-status'), { target: { value: 'overdue' } });
    expect(window.location.hash).toContain('status=overdue');

    expect(screen.queryByTestId('invoices-filter-org')).toBeNull();
    expect(window.location.hash).not.toContain('orgId=');
  });

  it('surfaces a Drafts shortcut that filters to drafts', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());
    const drafts = screen.getByTestId('invoices-drafts-card');
    expect(drafts).toHaveTextContent('Drafts');
    fireEvent.click(drafts);
    expect(window.location.hash).toContain('status=draft');
  });

  it('labels a single-currency Outstanding total from the OPEN subset, not rows[0]', async () => {
    // rows[0] is a void EUR invoice (excluded from the open subset); every open
    // invoice is USD. The strip must read $…, never €… — labeling the USD sum
    // with rows[0]'s currency was the original mislabeling bug.
    const mixed = [
      {
        ...INVOICES[0], id: 'inv-void', invoiceNumber: 'INV-VOID', status: 'void',
        currencyCode: 'EUR', balance: '999.00', createdAt: '2026-06-02T00:00:00Z',
      },
      { ...INVOICES[0], id: 'inv-open', invoiceNumber: 'INV-OPEN', status: 'sent', currencyCode: 'USD', balance: '100.00' },
    ];
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/invoices')) return json({ data: mixed });
      return json({}, false, 404);
    });
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-outstanding-strip')).toBeInTheDocument());

    const strip = screen.getByTestId('invoices-outstanding-strip');
    expect(strip).toHaveTextContent('$100.00');
    expect(strip.textContent).not.toContain('€');
  });

  it('hides the filter toolbar on a genuinely empty list', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/invoices')) return json({ data: [] });
      return json({}, false, 404);
    });
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-empty')).toBeInTheDocument());
    // Controls with nothing to act on are hidden in the true empty state.
    expect(screen.queryByTestId('invoices-filters')).not.toBeInTheDocument();
  });

  it('shows the filtered-empty state (not the teaching empty) when a filter returns nothing', async () => {
    window.location.hash = '#status=void';
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/invoices')) return json({ data: [] });
      return json({}, false, 404);
    });
    render(<InvoicesPage />);

    await screen.findByTestId('invoices-filtered-empty');
    // The first-run teaching empty must NOT be shown — that reads as data loss.
    expect(screen.queryByTestId('invoices-empty')).not.toBeInTheDocument();
    // The toolbar (and its existing Clear control) stays available while filtered.
    expect(screen.getByTestId('invoices-filters-clear')).toBeInTheDocument();
  });

  // #2421: useHashState starts at the SSR-safe default and adopts the hash
  // post-mount, so a deep-linked load fires TWO list requests — the unfiltered
  // seed and the filtered one. Without loadInvoices' fetchSeq guard, a slow seed
  // response landing last repaints the grid with ALL invoices while the Status
  // control still reads "overdue" — the wrong list under a filtered header.
  it('deep-linked filter wins when the unfiltered seed response resolves last', async () => {
    let releaseSeed!: () => void;
    const seedGate = new Promise<void>((resolve) => { releaseSeed = resolve; });

    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/invoices')) {
        // The seed request carries no status param — hold it open, and have it
        // return the FULL list so a stale win would be unmistakable.
        if (!input.includes('status=')) {
          await seedGate;
          return json({ data: INVOICES });
        }
        return json({ data: INVOICES.filter((i) => i.status === 'overdue') });
      }
      return json({}, false, 404);
    });

    window.location.hash = '#status=overdue';
    render(<InvoicesPage />);

    // The filtered response lands first and paints only the overdue invoice.
    await screen.findByTestId('invoices-row-inv-1');
    expect(screen.queryByTestId('invoices-row-inv-2')).not.toBeInTheDocument();

    // Now let the stale seed response resolve — it must be dropped.
    releaseSeed();
    // The table (not a spinner) is still rendered — the late response neither
    // repaints the rows nor strands the page in a loading state...
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());
    expect(screen.queryByTestId('invoices-row-inv-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoices-row-inv-1')).toBeInTheDocument();
    // ...and the list still agrees with the filter control.
    expect(screen.getByTestId('invoices-filter-status')).toHaveValue('overdue');
  });

  // The `(h) => (h ? readFilters(h) : undefined)` parse is what keeps the
  // EMPTY_FILTERS *reference* on the no-hash path. A bare `readFilters` returns
  // a fresh object, whose new identity retriggers the load effect on every mount.
  it('fetches the list exactly once when there is no hash', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    const listCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/invoices'));
    expect(listCalls).toHaveLength(1);
  });

  it('shows a Clear control once a filter is active and resets all filters', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());
    // No clear affordance until something is filtering.
    expect(screen.queryByTestId('invoices-filters-clear')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('invoices-filter-status'), { target: { value: 'overdue' } });
    fireEvent.click(screen.getByTestId('invoices-filters-clear'));
    // Assert on href (not `location.hash`, which jsdom reports '' even with a
    // dangling '#'): the shared writeHashFilters clear must leave no residual '#'.
    expect(window.location.href).not.toContain('#');
    expect(screen.getByTestId('invoices-filter-status')).toHaveValue('');
  });

  it('navigates to a row on click', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('invoices-row-inv-1'));
    expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-1');
  });

  it('assembles a draft and navigates to it', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/orgs/sites')) return json({ data: [] });
      if (input.includes('/invoices/assemble') && opts?.method === 'POST') {
        return json({ data: { invoice: { id: 'inv-new' }, lines: [] } });
      }
      if (input.startsWith('/invoices')) return json({ data: INVOICES });
      return json({}, false, 404);
    });
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoices-assemble-open'));
    await waitFor(() => expect(screen.getByTestId('invoices-assemble-dialog')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('invoices-assemble-org'), { target: { value: 'org-1' } });
    fireEvent.change(screen.getByTestId('invoices-assemble-from'), { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getByTestId('invoices-assemble-to'), { target: { value: '2026-05-31' } });
    fireEvent.click(screen.getByTestId('invoices-assemble-submit'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-new'));
  });

  it('renders the access-denied state (not the retryable error) on a 403', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/invoices')) return json({ error: 'forbidden' }, false, 403);
      return json({}, false, 404);
    });
    render(<InvoicesPage />);

    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument());
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to view invoices.")).toBeInTheDocument();
    // The generic data-load-failure UI must NOT appear for a 403.
    expect(screen.queryByTestId('invoices-error')).not.toBeInTheDocument();
    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
  });
});
