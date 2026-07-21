import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { updateLine } from '../../../lib/api/quotes';

type Perm = { resource: string; action: string };

// Mutable grant set so the same file can exercise both editable rows (writer)
// and readonly rows (quotes:read) — same pattern as QuoteEditor.permissions.test.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  // orgStore (imported by QuoteEditor for the customer select) registers an
  // org-id provider against the auth store at module scope.
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
}));

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Monthly services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const baseLine: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: 'Managed support', quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const baseQuote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '50.00', taxRate: null,
  taxTotal: '0.00', total: '50.00', oneTimeTotal: '50.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const updateLineMock = vi.mocked(updateLine);

const detailWith = (lines: QuoteDetailData['lines']): QuoteDetailData => ({
  quote: baseQuote, blocks: [block], lines,
});

describe('QuoteEditor — internal band progressive disclosure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The cost/margin toggle persists to localStorage — clear it so every test
    // starts from the collapsed default regardless of what a prior test toggled.
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
    updateLineMock.mockResolvedValue(
      { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
    );
  });

  it('defaults to a compact summary per line when cost & margin is shown', async () => {
    const detail = detailWith([
      { ...baseLine, unitCost: '100.00', unitPrice: '130.00', lineTotal: '130.00', sku: 'SW-1' },
    ]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    // Collapsed by default: the toggle reports it, the full form is hidden from
    // the a11y tree, and the summary carries SKU / Cost / Markup / Profit.
    expect(screen.getByTestId('quote-line-internal-toggle-line-1')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('quote-line-internal-detail-line-1')).toHaveAttribute('aria-hidden', 'true');
    const summary = screen.getByTestId('quote-line-internal-summary-line-1').textContent ?? '';
    expect(summary).toContain('SKU SW-1');
    expect(summary).toContain('Cost $100.00');
    expect(summary).toContain('Markup 30%');
    expect(summary).toContain('Profit $30.00');
  });

  it('summary shows — for missing cost/profit and omits an unset SKU', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    const summary = screen.getByTestId('quote-line-internal-summary-line-1').textContent ?? '';
    expect(summary).toContain('Cost —');
    expect(summary).toContain('Profit —');
    expect(summary).not.toContain('SKU');
  });

  it('expanding a line reveals the editing band; its inputs commit as before', async () => {
    const detail = detailWith([
      { ...baseLine, unitCost: '100.00', unitPrice: '130.00', lineTotal: '130.00' },
    ]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    fireEvent.click(screen.getByTestId('quote-line-internal-toggle-line-1'));
    expect(screen.getByTestId('quote-line-internal-toggle-line-1')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('quote-line-internal-detail-line-1')).toHaveAttribute('aria-hidden', 'false');
    // The summary yields to the full form while expanded.
    expect(screen.queryByTestId('quote-line-internal-summary-line-1')).not.toBeInTheDocument();

    const costEl = screen.getByTestId('quote-line-cost-line-1') as HTMLInputElement;
    // Unfocused, cost renders currency-formatted (matches the Cost/Markup/Profit
    // summary strip); the raw "100.00" only shows once the field is focused.
    expect(costEl.value).toBe('$100.00');
    fireEvent.change(costEl, { target: { value: '90' } });
    fireEvent.blur(costEl);
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitCost: 90 }));
  });

  it('a line with a dirty cost never auto-collapses; collapse lands after the save resyncs', async () => {
    const detail = detailWith([
      { ...baseLine, unitCost: '100.00', unitPrice: '130.00', lineTotal: '130.00' },
    ]);
    const { rerender } = render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    const toggle = screen.getByTestId('quote-line-internal-toggle-line-1');
    fireEvent.click(toggle); // expand
    fireEvent.change(screen.getByTestId('quote-line-cost-line-1'), { target: { value: '80' } });

    // Collapse request while the edit is unsaved: the band stays open.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('quote-line-internal-detail-line-1')).toHaveAttribute('aria-hidden', 'false');

    // Commit, then the server resync clears the dirty flag — NOW it collapses.
    fireEvent.blur(screen.getByTestId('quote-line-cost-line-1'));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitCost: 80 }));
    rerender(
      <QuoteEditor
        detail={detailWith([{ ...baseLine, unitCost: '80.00', unitPrice: '130.00', lineTotal: '130.00' }])}
        onChanged={vi.fn()}
      />,
    );
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
  });

  it('readonly rows get the same summary; expanding shows the full detail text', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    const detail = detailWith([
      { ...baseLine, unitCost: '30.00', sku: 'SW-9', partNumber: 'PN-9' },
    ]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    const toggle = screen.getByTestId('quote-line-internal-toggle-line-1');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('quote-line-internal-summary-line-1')).toHaveTextContent('Cost $30.00');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('quote-line-internal-detail-line-1')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('quote-line-sku-line-1')).toHaveTextContent('SKU SW-9');
    expect(screen.getByTestId('quote-line-partnumber-line-1')).toHaveTextContent('PN PN-9');
    expect(screen.getByTestId('quote-line-cost-line-1')).toHaveTextContent('$30.00');
  });
});

describe('QuoteEditor — cadence suffix only on mixed-cadence quotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
  });

  it('uniform cadence: no /mo suffix in the rows (rail still carries it)', async () => {
    const detail = detailWith([
      { ...baseLine, id: 'A', recurrence: 'monthly' },
      { ...baseLine, id: 'B', recurrence: 'monthly' },
    ]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect(within(screen.getByTestId('quote-line-A')).queryByText('/mo')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('quote-line-B')).queryByText('/mo')).not.toBeInTheDocument();
  });

  it('mixed cadences: recurring rows regain their /mo suffix', async () => {
    const detail = detailWith([
      { ...baseLine, id: 'A', recurrence: 'monthly' },
      { ...baseLine, id: 'B', recurrence: 'one_time' },
    ]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect(within(screen.getByTestId('quote-line-A')).getByText('/mo')).toBeInTheDocument();
    expect(within(screen.getByTestId('quote-line-B')).queryByText('/mo')).not.toBeInTheDocument();
  });

  it('readonly rows follow the same rule', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    const uniform = detailWith([
      { ...baseLine, id: 'A', recurrence: 'monthly' },
      { ...baseLine, id: 'B', recurrence: 'monthly' },
    ]);
    const { unmount } = render(<QuoteEditor detail={uniform} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(within(screen.getByTestId('quote-line-A')).queryAllByText('/mo')).toHaveLength(0);
    unmount();

    const mixed = detailWith([
      { ...baseLine, id: 'A', recurrence: 'monthly' },
      { ...baseLine, id: 'B', recurrence: 'one_time' },
    ]);
    render(<QuoteEditor detail={mixed} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    // Readonly rows suffix both the Unit price and Total cells.
    expect(within(screen.getByTestId('quote-line-A')).getAllByText('/mo').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('quote-line-B')).queryAllByText('/mo')).toHaveLength(0);
  });
});

describe('QuoteEditor — quiet ghost row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
  });

  it('hides qty/price/cadence chrome until the name has content, and restores it', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // Untouched ghost row: a single quiet name affordance.
    expect(screen.getByTestId('quote-ghost-qty-blk-1')).toHaveClass('hidden');
    expect(screen.getByTestId('quote-ghost-price-blk-1')).toHaveClass('hidden');
    expect(screen.getByTestId('quote-ghost-recurrence-blk-1')).toHaveClass('hidden');

    // Typing a name reveals the entry chrome…
    fireEvent.change(screen.getByTestId('quote-ghost-name-blk-1'), { target: { value: 'Backup agent' } });
    expect(screen.getByTestId('quote-ghost-qty-blk-1')).not.toHaveClass('hidden');
    expect(screen.getByTestId('quote-ghost-price-blk-1')).not.toHaveClass('hidden');
    expect(screen.getByTestId('quote-ghost-recurrence-blk-1')).not.toHaveClass('hidden');

    // …and clearing it hides the chrome again (row not focused).
    fireEvent.change(screen.getByTestId('quote-ghost-name-blk-1'), { target: { value: '' } });
    expect(screen.getByTestId('quote-ghost-qty-blk-1')).toHaveClass('hidden');
  });

  it('shows the chrome while focus is inside the row even with an empty name', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.focus(screen.getByTestId('quote-ghost-name-blk-1'));
    expect(screen.getByTestId('quote-ghost-qty-blk-1')).not.toHaveClass('hidden');
    fireEvent.blur(screen.getByTestId('quote-ghost-name-blk-1'));
    expect(screen.getByTestId('quote-ghost-qty-blk-1')).toHaveClass('hidden');
  });
});
