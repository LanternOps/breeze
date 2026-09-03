// Regression guard for #4668: at 1280px viewport with the left nav sidebar
// open, the quote editor's pricing table horizontally scrolled to reach the
// Total column (it fit fine with the sidebar collapsed). Root cause: the
// pricing table carried a blanket `min-w-[36rem]` floor plus a `min-w-[12rem]`
// floor on the Item column — together wider than the ~576px actually
// available for the table at that viewport/sidebar combination (1280 −
// 256px sidebar − 48px page padding − 300px rail − 24px grid gap − 76px
// canvas padding), so the table's declared minimum exceeded its container by
// a hairline and `overflow-x-auto` kicked in on any rendering variance
// (scrollbar, border, subpixel rounding).
//
// jsdom has no real layout engine, so this can't assert on-screen pixels or
// scroll state directly. Instead it locks the column-priority contract in
// Tailwind class form: Item (the lowest-priority column — it already
// degrades via its own text input / title tooltip) carries the smaller
// floor and shrinks first, while the table's blanket floor is reduced enough
// that Qty/Unit Price/Total/actions are never squeezed below their natural
// content width. See QuoteBlockCard.tsx / QuoteLineRows.tsx for the full
// math. Manual verification: apps/web dev server, quote editor at 1280px
// viewport with the sidebar expanded — Total is visible with no horizontal
// scrollbar on the pricing table; re-check at 1440/1920 for no regression.
import { render, screen, waitFor, within } from '@testing-library/react';
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
  updateBlock: vi.fn(),
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
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '100.00', taxRate: null,
  taxTotal: '0.00', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const lines: QuoteDetailData['lines'] = [
  {
    id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
    catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
    name: 'Managed support', description: null, quantity: '1.00',
    unitPrice: '100.00', taxable: false, customerVisible: true, lineTotal: '100.00',
    recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
    createdAt: '2026-06-01T00:00:00Z',
  },
];

const detail: QuoteDetailData = {
  quote: baseQuote,
  blocks: [{
    id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
    content: { label: 'Monthly services' },
    sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  }],
  lines,
};

describe('QuoteBlockCard pricing table — column-priority width contract (#4668)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reduces the table\'s blanket min-width floor below the old 36rem value', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const table = screen.getByTestId('quote-block-lines-blk-1');
    // The old blanket floor (36rem = 576px) matched the space actually
    // available at 1280px-with-sidebar-open to the pixel, so any rendering
    // variance (scrollbar, border, subpixel rounding) tipped it into
    // horizontal scroll. It must be meaningfully smaller now.
    expect(table.className).not.toMatch(/min-w-\[36rem\]/);
  });

  it('makes the Item column the lowest-priority (smallest floor) column, not the old 12rem', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const table = screen.getByTestId('quote-block-lines-blk-1');
    const headerRow = table.querySelector('thead tr');
    expect(headerRow).not.toBeNull();
    const itemHeader = within(headerRow as HTMLElement).getAllByRole('columnheader')[0];
    expect(itemHeader.className).not.toMatch(/min-w-\[12rem\]/);

    // The body cell's floor must track the header's floor (auto table layout
    // takes the wider of the two — a mismatch would silently keep the old
    // 12rem floor alive on the body side even if the header shrank).
    const nameInput = screen.getByTestId('quote-line-name-line-1');
    const itemCell = nameInput.closest('td');
    expect(itemCell).not.toBeNull();
    expect(itemCell!.className).not.toMatch(/min-w-\[12rem\]/);
  });
});
