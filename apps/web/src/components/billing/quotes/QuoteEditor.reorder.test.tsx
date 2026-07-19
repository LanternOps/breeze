import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { reorderBlocks, reorderLines } from '../../../lib/api/quotes';

// Writer permissions so the editor controls (incl. move buttons) render.
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
  moveLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const tableBlock: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};
const headingBlock: QuoteDetailData['blocks'][number] = {
  id: 'blk-2', quoteId: 'q-1', orgId: 'org-1', blockType: 'heading',
  content: { text: 'Summary', level: 2 }, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z',
};

const mkLine = (id: string, sortOrder: number): QuoteDetailData['lines'][number] => ({
  id, quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: `Line ${id}`, quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'monthly', termMonths: null, billingFrequency: null, sortOrder,
  createdAt: '2026-06-01T00:00:00Z',
});

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '100.00', taxRate: null,
    taxTotal: '0.00', total: '100.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '100.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [tableBlock, headingBlock],
  lines: [mkLine('l-1', 0), mkLine('l-2', 1)],
};

const reorderBlocksMock = vi.mocked(reorderBlocks);
const reorderLinesMock = vi.mocked(reorderLines);

describe('QuoteEditor — reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reorderBlocksMock.mockResolvedValue(okResponse());
    reorderLinesMock.mockResolvedValue(okResponse());
  });

  it('disables move-up on the first block and move-down on the last block', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    // Block arrangement lives in each block's gutter menu (one open at a time).
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    expect(screen.getByTestId('quote-block-move-up-blk-1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1')); // close
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-2'));
    expect(screen.getByTestId('quote-block-move-down-blk-2')).toBeDisabled();
  });

  it('moving the first block down sends the full reordered block id list', async () => {
    const onChanged = vi.fn();
    render(<QuoteEditor detail={detail} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    fireEvent.click(screen.getByTestId('quote-block-move-down-blk-1'));
    await waitFor(() => expect(reorderBlocksMock).toHaveBeenCalledWith('q-1', { blockIds: ['blk-2', 'blk-1'] }));
    // refresh() is coalesced (trailing), so onChanged fires shortly after the PATCH.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('moving the second block up sends the same reordered list', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-actions-blk-2'));
    fireEvent.click(screen.getByTestId('quote-block-move-up-blk-2'));
    await waitFor(() => expect(reorderBlocksMock).toHaveBeenCalledWith('q-1', { blockIds: ['blk-2', 'blk-1'] }));
  });

  it('disables move-up on the first line and move-down on the last line', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    // Move items live in each line's overflow menu (one at a time).
    fireEvent.click(screen.getByTestId('quote-line-actions-l-1'));
    expect(screen.getByTestId('quote-line-move-up-l-1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('quote-line-actions-l-1')); // close l-1's menu
    fireEvent.click(screen.getByTestId('quote-line-actions-l-2'));
    expect(screen.getByTestId('quote-line-move-down-l-2')).toBeDisabled();
  });

  it('moving the first line down sends the block id and reordered line list', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-actions-l-1'));
    fireEvent.click(screen.getByTestId('quote-line-move-down-l-1'));
    await waitFor(() => expect(reorderLinesMock).toHaveBeenCalledWith('q-1', 'blk-1', { lineIds: ['l-2', 'l-1'] }));
  });

  it('accumulates rapid reorder clicks into a single PATCH with the final order', async () => {
    // Three blocks so the first can be moved down twice. Two rapid clicks should
    // stack on the optimistic order and coalesce into ONE PATCH carrying the final
    // id list — not two competing requests (the central novel reorder behavior).
    const thirdBlock: QuoteDetailData['blocks'][number] = {
      id: 'blk-3', quoteId: 'q-1', orgId: 'org-1', blockType: 'heading',
      content: { text: 'Footer', level: 2 }, sortOrder: 2, createdAt: '2026-06-01T00:00:00Z',
    };
    const threeBlocks: QuoteDetailData = { ...detail, blocks: [tableBlock, headingBlock, thirdBlock] };
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    fireEvent.click(screen.getByTestId('quote-block-move-down-blk-1')); // [blk-2, blk-1, blk-3]
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    fireEvent.click(screen.getByTestId('quote-block-move-down-blk-1')); // [blk-2, blk-3, blk-1]

    await waitFor(() => expect(reorderBlocksMock).toHaveBeenCalledTimes(1));
    expect(reorderBlocksMock).toHaveBeenCalledWith('q-1', { blockIds: ['blk-2', 'blk-3', 'blk-1'] });
  });

  it('reverts the optimistic order and toasts when the reorder PATCH fails', async () => {
    // A failed reorder must not leave the UI showing an order that never persisted.
    reorderBlocksMock.mockResolvedValue(
      { ok: false, status: 500, statusText: 'err', json: vi.fn().mockResolvedValue({ error: 'boom' }) } as unknown as Response,
    );
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // blk-1 starts first (move-up disabled). Move it down (optimistically enables move-up).
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    fireEvent.click(screen.getByTestId('quote-block-move-down-blk-1'));
    await waitFor(() => expect(reorderBlocksMock).toHaveBeenCalledTimes(1));

    // Failure is surfaced and the optimistic order reverts (blk-1 back to first).
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // The menu closed on the move click — reopen it to read the reverted state.
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    await waitFor(() => expect(screen.getByTestId('quote-block-move-up-blk-1')).toBeDisabled());
  });
});
