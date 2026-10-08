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

// #8232: a product-like line with no part number or SKU never reaches the parts
// order, so the draft editor says so at the part-number field.
const HINT = 'Add a part number to include this in the parts order.';

describe('QuoteEditor — missing part number hint (#8232)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
    updateLineMock.mockResolvedValue(
      { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
    );
  });

  async function renderLines(lines: QuoteDetailData['lines']) {
    render(<QuoteEditor detail={detailWith(lines)} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));
  }

  it('shows the hint on a manual line with a cost and no identifier, without expanding the band', async () => {
    await renderLines([{ ...baseLine, unitCost: '329.00' }]);
    const hint = screen.getByTestId('quote-line-partnumber-hint-line-1');
    expect(hint).toHaveTextContent(HINT);
    // The part-number input is described by the hint for assistive tech.
    expect(screen.getByTestId('quote-line-partnumber-line-1').getAttribute('aria-describedby')).toContain(hint.id);
  });

  it('shows the hint on a hardware catalog line with no cost', async () => {
    await renderLines([{ ...baseLine, sourceType: 'catalog', itemType: 'hardware' }]);
    expect(screen.getByTestId('quote-line-partnumber-hint-line-1')).toHaveTextContent(HINT);
  });

  it('clears the hint as soon as a part number is typed', async () => {
    await renderLines([{ ...baseLine, unitCost: '329.00' }]);
    fireEvent.click(screen.getByTestId('quote-line-internal-toggle-line-1'));
    fireEvent.change(screen.getByTestId('quote-line-partnumber-line-1'), { target: { value: 'MD3Y4LL/A' } });
    expect(screen.queryByTestId('quote-line-partnumber-hint-line-1')).not.toBeInTheDocument();
  });

  it.each([
    ['a service line with a cost', { itemType: 'service' as const, unitCost: '40.00' }],
    ['a manual line without a cost', {}],
    ['a product line with a SKU', { itemType: 'hardware' as const, sku: 'LT-1' }],
    ['a product line with a part number', { unitCost: '10.00', partNumber: 'PN-1' }],
  ])('shows no hint for %s', async (_label, over) => {
    await renderLines([{ ...baseLine, ...over }]);
    expect(screen.queryByTestId('quote-line-partnumber-hint-line-1')).not.toBeInTheDocument();
  });

  it('hints in the add-manual-line form once a cost is entered without an identifier', async () => {
    await renderLines([baseLine]);
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));
    fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));
    expect(screen.queryByTestId('quote-manual-partnumber-hint-blk-1')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('quote-manual-cost-blk-1'), { target: { value: '329' } });
    expect(screen.getByTestId('quote-manual-partnumber-hint-blk-1')).toHaveTextContent(HINT);

    fireEvent.change(screen.getByTestId('quote-manual-partnumber-blk-1'), { target: { value: 'MD3Y4LL/A' } });
    expect(screen.queryByTestId('quote-manual-partnumber-hint-blk-1')).not.toBeInTheDocument();
  });
});

