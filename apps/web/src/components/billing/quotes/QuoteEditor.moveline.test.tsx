import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { moveLine, reorderLines } from '../../../lib/api/quotes';

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
  catalogItemImagePath: vi.fn().mockReturnValue('/catalog/x/image'),
}));

const okResponse = () =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: { ok: true } }) } as unknown as Response);

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const mkTable = (id: string, sortOrder: number, label?: string): QuoteDetailData['blocks'][number] => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: label ? { label } : {}, sortOrder, createdAt: '2026-06-01T00:00:00Z',
});

const mkLine = (id: string, blockId: string, sortOrder: number): QuoteDetailData['lines'][number] => ({
  id, quoteId: 'q-1', blockId, orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: `Line ${id}`, quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder,
  createdAt: '2026-06-01T00:00:00Z',
});

const quote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '150.00', taxRate: null,
  taxTotal: '0.00', total: '150.00', oneTimeTotal: '150.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const twoPanels: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services'), mkTable('blk-2', 1, 'Hardware')],
  lines: [mkLine('l-1', 'blk-1', 0), mkLine('l-2', 'blk-1', 1), mkLine('l-3', 'blk-2', 2)],
};

const onePanel: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services')],
  lines: [mkLine('l-1', 'blk-1', 0)],
};

const moveLineMock = vi.mocked(moveLine);
const reorderLinesMock = vi.mocked(reorderLines);

describe('QuoteEditor — move line between pricing panels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moveLineMock.mockResolvedValue(okResponse());
    reorderLinesMock.mockResolvedValue(okResponse());
  });

  it('hides the Move-to control when the quote has a single pricing panel', async () => {
    render(<QuoteEditor detail={onePanel} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-line-move-to-l-1')).not.toBeInTheDocument();
  });

  it('lists only the OTHER panels, labeled, in the Move-to menu', async () => {
    render(<QuoteEditor detail={twoPanels} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    const menu = screen.getByTestId('quote-line-move-to-menu-l-1');
    expect(within(menu).getByTestId('quote-line-move-to-l-1-blk-2')).toHaveTextContent('Hardware');
    expect(within(menu).queryByTestId('quote-line-move-to-l-1-blk-1')).not.toBeInTheDocument();
  });

  it('falls back to "Pricing table N" for an unlabeled target panel', async () => {
    const unlabeled: QuoteDetailData = {
      ...twoPanels,
      blocks: [mkTable('blk-1', 0, 'Services'), mkTable('blk-2', 1)],
    };
    render(<QuoteEditor detail={unlabeled} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    expect(screen.getByTestId('quote-line-move-to-l-1-blk-2')).toHaveTextContent('Pricing table 2');
  });

  it('moves the line optimistically and PATCHes the move endpoint', async () => {
    const onChanged = vi.fn();
    render(<QuoteEditor detail={twoPanels} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1-blk-2'));

    // Optimistic: l-1's qty input now renders inside blk-2's table, after l-3.
    const targetTable = screen.getByTestId('quote-block-lines-blk-2');
    expect(within(targetTable).getByTestId('quote-line-qty-l-1')).toBeInTheDocument();
    const sourceTable = screen.getByTestId('quote-block-lines-blk-1');
    expect(within(sourceTable).queryByTestId('quote-line-qty-l-1')).not.toBeInTheDocument();

    await waitFor(() => expect(moveLineMock).toHaveBeenCalledWith('q-1', 'l-1', { blockId: 'blk-2' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reverts the optimistic move and toasts when the PATCH fails', async () => {
    moveLineMock.mockResolvedValue(
      { ok: false, status: 500, statusText: 'err', json: vi.fn().mockResolvedValue({ error: 'boom' }) } as unknown as Response,
    );
    render(<QuoteEditor detail={twoPanels} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1-blk-2'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // Reverted: l-1 back in blk-1's table.
    await waitFor(() => {
      const sourceTable = screen.getByTestId('quote-block-lines-blk-1');
      expect(within(sourceTable).getByTestId('quote-line-qty-l-1')).toBeInTheDocument();
    });
  });

  it('cancels a pending chevron reorder debounce when a move fires', async () => {
    render(<QuoteEditor detail={twoPanels} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // Start a chevron reorder within blk-1 — this arms a 250ms debounced
    // reorderLines PATCH for blk-1.
    fireEvent.click(screen.getByTestId('quote-line-move-down-l-1'));

    // Immediately (same tick, no waiting) move l-1 into blk-2 via the Move-to menu.
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1'));
    fireEvent.click(screen.getByTestId('quote-line-move-to-l-1-blk-2'));

    await waitFor(() => expect(moveLineMock).toHaveBeenCalled());
    // Give the (cancelled) 250ms debounce window time to elapse.
    await new Promise((r) => setTimeout(r, 400));

    expect(reorderLinesMock).not.toHaveBeenCalled();
  });
});
