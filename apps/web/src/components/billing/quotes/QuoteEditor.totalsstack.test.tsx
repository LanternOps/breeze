import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// Task A of the quote-editor UX follow-up pass: a Subtotal → Tax → Total stack
// in the rail (Total visually dominant, One-time explicitly labeled pre-tax),
// mirrored as a Total figure in the `quote-totals-sticky` mobile bar.

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
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
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const baseLine: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: 'Setup', quantity: '1.00',
  unitPrice: '500.00', taxable: true, customerVisible: true, lineTotal: '500.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const baseQuote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '500.00', taxRate: '0.1',
  taxTotal: '50.00', total: '550.00', oneTimeTotal: '500.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '550.00', billToName: null, introNotes: null,
  terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const detailWith = (lines: QuoteDetailData['lines'], quoteOverride: Partial<QuoteDetailData['quote']> = {}): QuoteDetailData => ({
  quote: { ...baseQuote, ...quoteOverride }, blocks: [block], lines,
});

describe('QuoteEditor — rail grand-total stack (Subtotal → Tax → Total)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders Subtotal, Tax, and a visually dominant Total with correct values; labels One-time as pre-tax', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    expect(screen.getByTestId('quote-total-onetime')).toHaveTextContent('$500.00');
    expect(screen.getByText('One-time (pre-tax)')).toBeInTheDocument();
    expect(screen.getByTestId('quote-total-subtotal')).toHaveTextContent('$500.00');
    expect(screen.getByTestId('quote-total-tax')).toHaveTextContent('$50.00');
    expect(screen.getByTestId('quote-total-grand')).toHaveTextContent('$550.00');

    // Total is the dominant figure in the stack — bold + larger than the
    // Subtotal/Tax rows above it.
    expect(screen.getByTestId('quote-total-grand').closest('div')).toHaveClass('font-semibold');
  });

  it('labels Subtotal/Total as bare "Subtotal"/"Total" for a one-time-only quote (no recurring)', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    // "Total" bare-text also appears as the line-items table's column header
    // (Item/Qty/…/Total), so scope the label lookup to the sibling <dt> of the
    // testid'd row rather than a page-wide text search.
    expect(screen.getByTestId('quote-total-subtotal').closest('div')?.querySelector('dt')).toHaveTextContent('Subtotal');
    expect(screen.getByTestId('quote-total-grand').closest('div')?.querySelector('dt')).toHaveTextContent('Total');
  });

  it('relabels Subtotal/Total as "First period …" once a recurring cadence is mixed in, matching the customer document', async () => {
    const monthlyLine: QuoteDetailData['lines'][number] = {
      ...baseLine, id: 'line-2', recurrence: 'monthly', taxable: false, unitPrice: '50.00', lineTotal: '50.00',
    };
    const detail = detailWith([baseLine, monthlyLine], {
      subtotal: '550.00', total: '600.00', monthlyRecurringTotal: '50.00',
    });
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    expect(screen.getByTestId('quote-total-subtotal').closest('div')?.querySelector('dt')).toHaveTextContent('First period subtotal');
    expect(screen.getByTestId('quote-total-subtotal')).toHaveTextContent('$550.00');
    expect(screen.getByTestId('quote-total-grand')).toHaveTextContent('$600.00');
  });

  it('is div-by-zero safe for an empty (all-zero) quote — no NaN, no crash', async () => {
    const detail = detailWith([], {
      subtotal: '0.00', taxTotal: '0.00', total: '0.00', taxRate: null,
      oneTimeTotal: '0.00', dueOnAcceptanceTotal: '0.00',
    });
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    expect(screen.getByTestId('quote-total-subtotal')).toHaveTextContent('$0.00');
    expect(screen.getByTestId('quote-total-grand')).toHaveTextContent('$0.00');
    // No tax rate set and no tax owed → the Tax row stays silent (matches the
    // pre-existing zero-value-cadence convention for the other rows).
    expect(screen.queryByTestId('quote-total-tax')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-editor')).not.toHaveTextContent('NaN');
  });

  it('mirrors the Total figure in the quote-totals-sticky mobile bar', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    const sticky = screen.getByTestId('quote-totals-sticky');
    expect(sticky).toContainElement(screen.getByTestId('quote-totals-sticky-total'));
    expect(screen.getByTestId('quote-totals-sticky-total')).toHaveTextContent('$550.00');
  });
});
