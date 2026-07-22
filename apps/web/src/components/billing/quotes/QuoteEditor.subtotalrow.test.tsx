// "Show subtotal row" previously only affected the customer-facing
// document/PDF — checking it in the editor had no visible effect in the
// expanded pricing table itself. This covers the editor-side footer row that
// mirrors the toggle (QuoteBlockCard.tsx), independent of QuoteDocument's own
// subtotal row (covered by QuoteDocument.test.tsx).
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

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
  updateBlock: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const baseQuote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '150.00', taxRate: null,
  taxTotal: '0.00', total: '150.00', oneTimeTotal: '150.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const lines: QuoteDetailData['lines'] = [
  {
    id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
    catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
    name: null, description: 'Managed support', quantity: '1.00',
    unitPrice: '100.00', taxable: false, customerVisible: true, lineTotal: '100.00',
    recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
    createdAt: '2026-06-01T00:00:00Z',
  },
  {
    id: 'line-2', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
    catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
    name: null, description: 'Setup fee', quantity: '1.00',
    unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
    recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 1,
    createdAt: '2026-06-01T00:00:00Z',
  },
];

function detailWithSubtotal(showSubtotal: boolean | undefined): QuoteDetailData {
  return {
    quote: baseQuote,
    blocks: [{
      id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
      content: { label: 'Monthly services', ...(showSubtotal === undefined ? {} : { showSubtotal }) },
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }],
    lines,
  };
}

describe('QuoteEditor — pricing-table subtotal footer row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a subtotal footer summing the block\'s line totals when the toggle is checked', async () => {
    render(<QuoteEditor detail={detailWithSubtotal(true)} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const checkbox = screen.getByTestId('quote-block-subtotal-toggle-blk-1') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    const row = screen.getByTestId('quote-block-subtotal-row-blk-1');
    expect(row).toHaveTextContent('$150.00'); // 100.00 + 50.00
  });

  it('hides the footer row when the toggle is unchecked', async () => {
    render(<QuoteEditor detail={detailWithSubtotal(false)} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect((screen.getByTestId('quote-block-subtotal-toggle-blk-1') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('quote-block-subtotal-row-blk-1')).not.toBeInTheDocument();
  });

  it('hides the footer row by default (content carries no showSubtotal key)', async () => {
    render(<QuoteEditor detail={detailWithSubtotal(undefined)} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-block-subtotal-row-blk-1')).not.toBeInTheDocument();
  });
});
