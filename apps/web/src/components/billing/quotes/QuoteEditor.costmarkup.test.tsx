import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { addManualLine, updateLine } from '../../../lib/api/quotes';
import { fetchWithAuth } from '../../../stores/auth';
import { enrichCatalogItemRequest } from '../../../lib/api/catalog';

// Writer permissions so the inline line editor renders (read-only hides it).
vi.mock('../../../stores/auth', () => ({
  // orgStore (imported by QuoteEditor for the customer select) registers an
  // org-id provider against the auth store at module scope.
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
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
  enrichCatalogItemRequest: vi.fn(),
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
const addManualLineMock = vi.mocked(addManualLine);

describe('QuoteEditor — per-line cost/markup/net strip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The cost/margin toggle persists to localStorage — clear it so every test
    // starts from the collapsed default regardless of what a prior test toggled.
    localStorage.clear();
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

    // The rail Margin panel is governed by the same "Show cost & margin" toggle
    // as the per-line bands — one toggle honestly means "no margin on screen".
    expect(screen.queryByTestId('quote-margin-cost')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    expect(screen.getByTestId('quote-margin-cost')).toHaveTextContent('$125.00');
    expect(screen.getByTestId('quote-margin-net-onetime')).toHaveTextContent('$30.00');
    expect(screen.getByTestId('quote-margin-net-monthly')).toHaveTextContent('$15.00');
    expect(screen.getByTestId('quote-margin-missing-cost')).toBeInTheDocument();
  });

  it('manual-add preserves an explicit cost of 0 (not null)', async () => {
    addManualLineMock.mockResolvedValue(
      { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
    );
    const detail: QuoteDetailData = {
      quote: baseQuote,
      blocks: [block],
      lines: [baseLine],
    };
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // The add-line panel defaults to catalog mode — switch to the manual line form.
    fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));

    fireEvent.change(screen.getByTestId('quote-manual-name-blk-1'), { target: { value: 'Freebie' } });
    fireEvent.change(screen.getByTestId('quote-manual-desc-blk-1'), { target: { value: 'Included at no charge' } });
    fireEvent.change(screen.getByTestId('quote-manual-qty-blk-1'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('quote-manual-price-blk-1'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('quote-manual-cost-blk-1'), { target: { value: '0' } });

    fireEvent.click(screen.getByTestId('quote-manual-add-blk-1'));

    await waitFor(() => expect(addManualLineMock).toHaveBeenCalled());
    expect(addManualLineMock).toHaveBeenCalledWith(
      'q-1',
      expect.objectContaining({ unitCost: 0 }),
    );
  });
});

describe('QuoteEditor — add-form two-way markup and auto-fill pricing', () => {
  const emptyDetail: QuoteDetailData = { quote: baseQuote, blocks: [block], lines: [] };

  beforeEach(() => { vi.clearAllMocks(); });

  it('markup% and price stay two-way coupled through cost edits', async () => {
    render(<QuoteEditor detail={emptyDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));

    const costEl = screen.getByTestId('quote-manual-cost-blk-1') as HTMLInputElement;
    const markupEl = screen.getByTestId('quote-manual-markup-blk-1') as HTMLInputElement;
    const priceEl = screen.getByTestId('quote-manual-price-blk-1') as HTMLInputElement;

    // Markup needs a cost base; the pristine 0.00 price yields no markup value.
    expect(markupEl.disabled).toBe(true);
    fireEvent.change(costEl, { target: { value: '100' } });
    expect(markupEl.disabled).toBe(false);
    expect(markupEl.value).toBe('');

    // Markup drives price…
    fireEvent.change(markupEl, { target: { value: '30' } });
    expect(priceEl.value).toBe('130.00');

    // …price drives markup…
    fireEvent.change(priceEl, { target: { value: '150' } });
    expect(markupEl.value).toBe('50');

    // …and a cost edit recomputes the side the user did NOT type last (price
    // was last authoritative, so markup re-derives; price stands).
    fireEvent.change(costEl, { target: { value: '75' } });
    expect(markupEl.value).toBe('100');
    expect(priceEl.value).toBe('150');

    // Flip authority back to markup: a later cost edit now recomputes price.
    fireEvent.change(markupEl, { target: { value: '20' } });
    expect(priceEl.value).toBe('90.00');
    fireEvent.change(costEl, { target: { value: '100' } });
    expect(priceEl.value).toBe('120.00');
  });

  it('auto-fill fills cost and prices the line at the partner default markup', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (input: unknown) =>
      (input === '/orgs/partners/me'
        ? { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ defaultMarkupPercent: '20.00' }) }
        : { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) }) as unknown as Response,
    );
    vi.mocked(enrichCatalogItemRequest).mockResolvedValue(
      {
        ok: true, status: 200, statusText: 'OK',
        json: vi.fn().mockResolvedValue({
          data: {
            draft: {
              name: 'APC UPS', description: 'Battery backup', itemType: 'hardware',
              unitOfMeasure: 'each', taxable: true, taxCategory: null,
            },
            priceGuidance: 'typically $80–120',
            estimatedCost: 80,
            provenance: {
              source: 'ai_enrich', model: 'm', query: 'APC UPS', suggestion: {},
              enrichedAt: '2026-06-25T00:00:00Z', enrichedBy: 'u1',
            },
          },
        }),
      } as unknown as Response,
    );

    render(<QuoteEditor detail={emptyDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledWith('/orgs/partners/me'));
    fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));

    fireEvent.change(screen.getByTestId('catalog-enrich-input-quote-blk-1'), { target: { value: 'APC UPS' } });
    fireEvent.click(screen.getByTestId('catalog-enrich-btn-quote-blk-1'));

    await waitFor(() =>
      expect((screen.getByTestId('quote-manual-name-blk-1') as HTMLInputElement).value).toBe('APC UPS'),
    );
    expect((screen.getByTestId('quote-manual-cost-blk-1') as HTMLInputElement).value).toBe('80.00');
    // price = cost × (1 + 20%) via the partner default markup
    expect((screen.getByTestId('quote-manual-price-blk-1') as HTMLInputElement).value).toBe('96.00');
    expect((screen.getByTestId('quote-manual-markup-blk-1') as HTMLInputElement).value).toBe('20');
    // The summary line tells the user exactly what the AI touched.
    const summary = screen.getByTestId('quote-manual-autofilled-blk-1').textContent ?? '';
    expect(summary).toMatch(/estimated cost/);
    expect(summary).toMatch(/20% markup/);
  });

  it('auto-fill never overwrites a cost or price the user already entered', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (input: unknown) =>
      (input === '/orgs/partners/me'
        ? { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ defaultMarkupPercent: '20.00' }) }
        : { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) }) as unknown as Response,
    );
    vi.mocked(enrichCatalogItemRequest).mockResolvedValue(
      {
        ok: true, status: 200, statusText: 'OK',
        json: vi.fn().mockResolvedValue({
          data: {
            draft: {
              name: 'APC UPS', description: null, itemType: 'hardware',
              unitOfMeasure: 'each', taxable: false, taxCategory: null,
            },
            priceGuidance: null,
            estimatedCost: 80,
            provenance: {
              source: 'ai_enrich', model: 'm', query: 'APC UPS', suggestion: {},
              enrichedAt: '2026-06-25T00:00:00Z', enrichedBy: 'u1',
            },
          },
        }),
      } as unknown as Response,
    );

    render(<QuoteEditor detail={emptyDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledWith('/orgs/partners/me'));
    fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));

    // The tech already typed their real numbers before running auto-fill.
    fireEvent.change(screen.getByTestId('quote-manual-cost-blk-1'), { target: { value: '189' } });
    fireEvent.change(screen.getByTestId('quote-manual-price-blk-1'), { target: { value: '205' } });

    fireEvent.change(screen.getByTestId('catalog-enrich-input-quote-blk-1'), { target: { value: 'APC UPS' } });
    fireEvent.click(screen.getByTestId('catalog-enrich-btn-quote-blk-1'));

    await waitFor(() =>
      expect((screen.getByTestId('quote-manual-name-blk-1') as HTMLInputElement).value).toBe('APC UPS'),
    );
    expect((screen.getByTestId('quote-manual-cost-blk-1') as HTMLInputElement).value).toBe('189');
    expect((screen.getByTestId('quote-manual-price-blk-1') as HTMLInputElement).value).toBe('205');
  });
});
