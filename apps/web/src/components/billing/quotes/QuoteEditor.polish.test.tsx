import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData, QuoteBlock, QuoteLine } from './quoteTypes';

// Task F of the quote-editor UX follow-up pass ("polish sweep"): the ADD
// SECTION heading-text gating, per-block sticky column headers, SKU/PN help
// text, and the Alt+ArrowDown/Up block-jump shortcut.
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
  polishTextRequest: vi.fn(),
}));

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  updateBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const quote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '10.00', taxRate: null,
  taxTotal: '0.00', total: '10.00', oneTimeTotal: '10.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const mkTable = (id: string, sortOrder: number, label?: string): QuoteBlock => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: label ? { label } : {}, sortOrder, createdAt: '2026-06-01T00:00:00Z',
});
const mkHeading = (id: string, sortOrder: number, text: string): QuoteBlock => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType: 'heading',
  content: { text, level: 2 }, sortOrder, createdAt: '2026-06-01T00:00:00Z',
});
const mkLine = (id: string, blockId: string, sortOrder: number, overrides: Partial<QuoteLine> = {}): QuoteLine => ({
  id, quoteId: 'q-1', blockId, orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, imageId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: 'Widget', description: null, quantity: '1.00', unitPrice: '10.00', taxable: false,
  customerVisible: true, lineTotal: '10.00', recurrence: 'one_time', termMonths: null,
  billingFrequency: null, sortOrder, createdAt: '2026-06-01T00:00:00Z', ...overrides,
});

const emptyDetail: QuoteDetailData = { quote, blocks: [], lines: [] };

const onePricingBlock: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services')],
  lines: [mkLine('l-1', 'blk-1', 0)],
};

const threeBlocks: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services'), mkHeading('blk-2', 1, 'Summary'), mkTable('blk-3', 2)],
  lines: [mkLine('l-1', 'blk-1', 0), mkLine('l-3', 'blk-3', 1)],
};

describe('QuoteEditor — ADD SECTION heading-text gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the heading-text input for the default "Heading" chip', async () => {
    render(<QuoteEditor detail={emptyDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-block-heading-text')).toBeInTheDocument();
  });

  it('hides the heading-text input for every other block type', async () => {
    render(<QuoteEditor detail={emptyDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    for (const type of ['rich_text', 'image', 'line_items', 'contract']) {
      fireEvent.click(screen.getByTestId(`quote-add-block-type-${type}`));
      expect(screen.queryByTestId('quote-block-heading-text')).not.toBeInTheDocument();
    }
  });
});

describe('QuoteEditor — sticky per-block column headers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins the header row (sticky + solid background) above the scrolling rows', async () => {
    render(<QuoteEditor detail={onePricingBlock} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-block-lines-blk-1')).toBeInTheDocument());

    const table = screen.getByTestId('quote-block-lines-blk-1');
    const headerCells = table.querySelectorAll('thead th');
    expect(headerCells.length).toBeGreaterThan(0);
    headerCells.forEach((th) => {
      expect(th.className).toMatch(/\bsticky\b/);
      expect(th.className).toMatch(/\btop-0\b/);
      expect(th.className).toMatch(/\bbg-card\b/);
    });
  });
});

describe('QuoteEditor — SKU vs PN help text', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives the SKU and PN inputs distinct, discoverable tooltips (not identical text)', async () => {
    render(<QuoteEditor detail={onePricingBlock} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-line-l-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-internal-toggle-l-1'));
    const skuInput = screen.getByTestId('quote-line-sku-l-1');
    const pnInput = screen.getByTestId('quote-line-partnumber-l-1');

    expect(skuInput.getAttribute('title')).toBeTruthy();
    expect(pnInput.getAttribute('title')).toBeTruthy();
    expect(skuInput.getAttribute('title')).not.toEqual(pnInput.getAttribute('title'));

    // aria-describedby resolves to a real, non-empty node for screen readers too.
    const skuHelpId = skuInput.getAttribute('aria-describedby')?.split(' ')[0];
    const pnHelpId = pnInput.getAttribute('aria-describedby')?.split(' ')[0];
    expect(skuHelpId && document.getElementById(skuHelpId)?.textContent).toBeTruthy();
    expect(pnHelpId && document.getElementById(pnHelpId)?.textContent).toBeTruthy();
  });
});

describe('QuoteEditor — Alt+ArrowDown/Up block-jump shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('Alt+ArrowDown from the first block focuses the next block container', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    screen.getByTestId('quote-block-container-blk-1').focus();
    fireEvent.keyDown(screen.getByTestId('quote-block-container-blk-1'), { key: 'ArrowDown', altKey: true });

    expect(document.activeElement).toBe(screen.getByTestId('quote-block-container-blk-2'));
  });

  it('Alt+ArrowUp moves back to the previous block', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    screen.getByTestId('quote-block-container-blk-2').focus();
    fireEvent.keyDown(screen.getByTestId('quote-block-container-blk-2'), { key: 'ArrowUp', altKey: true });

    expect(document.activeElement).toBe(screen.getByTestId('quote-block-container-blk-1'));
  });

  it('a bare (non-Alt) arrow key inside a name input is left alone — never hijacked', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-line-l-1')).toBeInTheDocument());

    const nameInput = screen.getByTestId('quote-line-name-l-1');
    nameInput.focus();
    fireEvent.keyDown(nameInput, { key: 'ArrowDown' });

    // Focus never jumps away from the input the user is typing in.
    expect(document.activeElement).toBe(nameInput);
  });
});
