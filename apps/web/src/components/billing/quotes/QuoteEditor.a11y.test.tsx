import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// #2151: every qty/price input in the editor answered to the same accessible
// name ("Quantity" / "Unit price"), so a screen reader's form-controls list was
// a run of indistinguishable entries with no way to tell which line each one
// belonged to. The sibling announce-on-mount fix lives in
// QuoteEditor.srtotals.test.tsx (it needs a different i18n mock).

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
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  updateQuote: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const baseLine: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: 'Firewall install', description: 'Setup', quantity: '1.00',
  unitPrice: '500.00', taxable: true, customerVisible: true, lineTotal: '500.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const baseQuote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '500.00', taxRate: '0',
  taxTotal: '0.00', total: '500.00', oneTimeTotal: '500.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '500.00', billToName: null, introNotes: null,
  terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const detailWith = (lines: QuoteDetailData['lines']): QuoteDetailData => ({
  quote: baseQuote, blocks: [block], lines,
});

describe('QuoteEditor — line-field accessible names (#2151)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names each persisted line’s qty and price inputs after its item', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    expect(screen.getByTestId('quote-line-qty-line-1')).toHaveAttribute('aria-label', 'Quantity for Firewall install');
    expect(screen.getByTestId('quote-line-price-line-1')).toHaveAttribute('aria-label', 'Unit price for Firewall install');
  });

  it('gives two lines distinct qty/price names rather than N identical "Quantity" controls', async () => {
    const second: QuoteDetailData['lines'][number] = {
      ...baseLine, id: 'line-2', name: 'Switch install', sortOrder: 1,
    };
    render(<QuoteEditor detail={detailWith([baseLine, second])} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    const names = ['quote-line-qty-line-1', 'quote-line-qty-line-2', 'quote-line-price-line-1', 'quote-line-price-line-2']
      .map((id) => screen.getByTestId(id).getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('falls back to the shared "this line" phrase for an untitled line instead of an empty name', async () => {
    const untitled: QuoteDetailData['lines'][number] = { ...baseLine, name: null, description: null };
    render(<QuoteEditor detail={detailWith([untitled])} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    expect(screen.getByTestId('quote-line-qty-line-1')).toHaveAttribute('aria-label', 'Quantity for this line');
  });

  it('names the new-line row’s qty/price distinctly from the persisted rows', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    expect(screen.getByTestId('quote-ghost-qty-blk-1')).toHaveAttribute('aria-label', 'New line quantity');
    expect(screen.getByTestId('quote-ghost-price-blk-1')).toHaveAttribute('aria-label', 'New line unit price');
  });
});
