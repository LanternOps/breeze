// Money correctness in the editable unit-price / internal-cost / ghost-price
// inputs: formatted (currency, thousands-separated) while blurred — matching
// the adjacent read-only Total/summary cells — raw editable decimal while
// focused, commit + reformat on blur, sanitized keystrokes (no NaN commits),
// and ch-based width so long values are never clipped.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { updateLine } from '../../../lib/api/quotes';

// Writer permissions so the inline line editor renders (read-only hides it).
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
  unitPrice: '1234.00', taxable: false, customerVisible: true, lineTotal: '1234.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const baseQuote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '1234.00', taxRate: null,
  taxTotal: '0.00', total: '1234.00', oneTimeTotal: '1234.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const detailWith = (lines: QuoteDetailData['lines']): QuoteDetailData => ({
  quote: baseQuote, blocks: [block], lines,
});

const updateLineMock = vi.mocked(updateLine);

describe('QuoteLineRows — money-formatted price/cost inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    updateLineMock.mockResolvedValue(
      { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
    );
  });

  it('unit price renders currency-formatted while blurred and the raw decimal while focused', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));

    const priceEl = screen.getByTestId('quote-line-price-line-1') as HTMLInputElement;
    expect(priceEl.value).toBe('$1,234.00');

    fireEvent.focus(priceEl);
    expect(priceEl.value).toBe('1234.00');
  });

  it('commits the typed value on blur and reformats back to currency', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));

    const priceEl = screen.getByTestId('quote-line-price-line-1') as HTMLInputElement;
    fireEvent.focus(priceEl);
    fireEvent.change(priceEl, { target: { value: '75' } });
    expect(priceEl.value).toBe('75'); // still raw while focused
    fireEvent.blur(priceEl);

    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitPrice: 75 }));
    expect(priceEl.value).toBe('$75.00'); // reformatted once unfocused
  });

  it('internal cost input formats the same way once the band is expanded', async () => {
    render(<QuoteEditor detail={detailWith([{ ...baseLine, unitCost: '100.00' }])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));
    fireEvent.click(screen.getByTestId('quote-line-internal-toggle-line-1'));

    const costEl = screen.getByTestId('quote-line-cost-line-1') as HTMLInputElement;
    expect(costEl.value).toBe('$100.00');
    fireEvent.focus(costEl);
    expect(costEl.value).toBe('100.00');
    fireEvent.blur(costEl);
    expect(costEl.value).toBe('$100.00');
  });

  it('sanitizes garbage keystrokes so a non-numeric value can never commit', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));

    const priceEl = screen.getByTestId('quote-line-price-line-1') as HTMLInputElement;
    fireEvent.focus(priceEl);
    // Letters around a real number are stripped rather than rejecting the
    // whole keystroke — the digits/decimal point the user typed survive.
    fireEvent.change(priceEl, { target: { value: 'abc123.45xyz' } });
    expect(priceEl.value).toBe('123.45');
    fireEvent.blur(priceEl);
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitPrice: 123.45 }));
  });

  it('a lone decimal point (no digits) is rejected on blur with no PATCH and no NaN in the field', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));

    const priceEl = screen.getByTestId('quote-line-price-line-1') as HTMLInputElement;
    fireEvent.focus(priceEl);
    fireEvent.change(priceEl, { target: { value: '.' } });
    fireEvent.blur(priceEl);

    await waitFor(() => expect(screen.getByTestId('quote-line-price-error-line-1')).toBeInTheDocument());
    expect(updateLineMock).not.toHaveBeenCalled();
    // Rejected entry stays visible (raw, not "NaN" or a silently-formatted
    // "$0.00") so the user can see and correct it.
    expect(priceEl.value).toBe('.');
  });

  it('grows the input width for a long (7-digit) price instead of clipping it', async () => {
    render(<QuoteEditor detail={detailWith([{ ...baseLine, unitPrice: '1234567.89', lineTotal: '1234567.89' }])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));

    const priceEl = screen.getByTestId('quote-line-price-line-1') as HTMLInputElement;
    // Unfocused display "$1,234,567.89" is 14 characters — width must grow well
    // past the old fixed w-24 (~12ch) to avoid clipping the formatted value.
    const widthCh = parseInt(priceEl.style.width, 10);
    expect(widthCh).toBeGreaterThanOrEqual(14);
  });

  it('grows the markup input width for a longer value like "155.1"', async () => {
    render(<QuoteEditor detail={detailWith([{ ...baseLine, unitCost: '100.00', unitPrice: '255.10' }])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));
    fireEvent.click(screen.getByTestId('quote-line-internal-toggle-line-1'));

    const markupEl = screen.getByTestId('quote-line-markup-line-1') as HTMLInputElement;
    expect(markupEl.value).toBe('155.1'); // (255.10-100)/100
    const widthCh = parseInt(markupEl.style.width, 10);
    expect(widthCh).toBeGreaterThanOrEqual(7); // > the old fixed w-16 (~8ch) floor for short values
  });

  it('ghost-row price formats on blur and shows the raw decimal while focused', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('quote-ghost-name-blk-1'), { target: { value: 'Backup agent' } });
    const ghostPrice = screen.getByTestId('quote-ghost-price-blk-1') as HTMLInputElement;
    fireEvent.focus(ghostPrice);
    fireEvent.change(ghostPrice, { target: { value: '2500' } });
    expect(ghostPrice.value).toBe('2500'); // raw while focused
    fireEvent.blur(ghostPrice);
    expect(ghostPrice.value).toBe('$2,500.00'); // formatted once unfocused
  });
});
