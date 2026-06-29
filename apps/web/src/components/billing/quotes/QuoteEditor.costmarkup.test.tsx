import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { updateLine } from '../../../lib/api/quotes';

// Writer permissions so the inline line editor renders (read-only hides it).
vi.mock('../../../stores/auth', () => ({
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
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

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

describe('QuoteEditor — per-line cost/markup/net strip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateLineMock.mockResolvedValue(
      { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
    );
  });

  it('editing markup% sets the unit price from cost', async () => {
    const detail: QuoteDetailData = {
      quote: baseQuote,
      blocks: [block],
      lines: [{ ...baseLine, unitCost: '100.00', unitPrice: '130.00', lineTotal: '130.00' }],
    };
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const markup = screen.getByTestId('quote-line-markup-line-1') as HTMLInputElement;
    expect(markup.value).toBe('30'); // (130-100)/100

    fireEvent.change(markup, { target: { value: '50' } });
    fireEvent.blur(markup);

    // Price reflects 150.00 optimistically, and the PATCH carries unitPrice 150.
    await waitFor(() =>
      expect((screen.getByTestId('quote-line-price-line-1') as HTMLInputElement).value).toBe('150.00'),
    );
    await waitFor(() =>
      expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitPrice: 150 }),
    );
  });

  it('net shows price-minus-cost times qty, and "—" when cost is absent', async () => {
    const detail: QuoteDetailData = {
      quote: baseQuote,
      blocks: [block],
      lines: [
        { ...baseLine, id: 'A', unitCost: '100.00', unitPrice: '130.00', quantity: '2.00', lineTotal: '260.00' },
        { ...baseLine, id: 'B', unitCost: null, unitPrice: '130.00', quantity: '2.00', lineTotal: '260.00' },
      ],
    };
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect(screen.getByTestId('quote-line-net-A')).toHaveTextContent('$60.00');
    expect(screen.getByTestId('quote-line-net-B')).toHaveTextContent('—');
  });

  it('rail shows net profit by cadence and flags lines missing cost', async () => {
    const detail: QuoteDetailData = {
      quote: baseQuote,
      blocks: [block],
      lines: [
        // one-time: cost 100 / price 130 → net 30
        { ...baseLine, id: 'A', recurrence: 'one_time', unitCost: '100.00', unitPrice: '130.00', quantity: '1.00', lineTotal: '130.00' },
        // monthly: cost 25 / price 40 → net 15
        { ...baseLine, id: 'B', recurrence: 'monthly', unitCost: '25.00', unitPrice: '40.00', quantity: '1.00', lineTotal: '40.00' },
        // no cost → excluded from net, counted in linesMissingCost
        { ...baseLine, id: 'C', recurrence: 'one_time', unitCost: null, unitPrice: '130.00', quantity: '1.00', lineTotal: '130.00' },
      ],
    };
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect(screen.getByTestId('quote-margin-cost')).toHaveTextContent('$125.00');
    expect(screen.getByTestId('quote-margin-net-onetime')).toHaveTextContent('$30.00');
    expect(screen.getByTestId('quote-margin-net-monthly')).toHaveTextContent('$15.00');
    expect(screen.getByTestId('quote-margin-missing-cost')).toBeInTheDocument();
  });
});
