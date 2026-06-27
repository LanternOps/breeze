import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { reorderBlocks, reorderLines } from '../../../lib/api/quotes';

// Writer permissions so the editor controls (incl. move buttons) render.
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
  catalogItemId: null, parentLineId: null, description: `Line ${id}`, quantity: '1.00',
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
    expect(screen.getByTestId('quote-block-move-up-blk-1')).toBeDisabled();
    expect(screen.getByTestId('quote-block-move-down-blk-2')).toBeDisabled();
  });

  it('moving the first block down sends the full reordered block id list', async () => {
    const onChanged = vi.fn();
    render(<QuoteEditor detail={detail} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-move-down-blk-1'));
    await waitFor(() => expect(reorderBlocksMock).toHaveBeenCalledWith('q-1', { blockIds: ['blk-2', 'blk-1'] }));
    // refresh() is coalesced (trailing), so onChanged fires shortly after the PATCH.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('moving the second block up sends the same reordered list', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-move-up-blk-2'));
    await waitFor(() => expect(reorderBlocksMock).toHaveBeenCalledWith('q-1', { blockIds: ['blk-2', 'blk-1'] }));
  });

  it('disables move-up on the first line and move-down on the last line', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-line-move-up-l-1')).toBeDisabled();
    expect(screen.getByTestId('quote-line-move-down-l-2')).toBeDisabled();
  });

  it('moving the first line down sends the block id and reordered line list', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-move-down-l-1'));
    await waitFor(() => expect(reorderLinesMock).toHaveBeenCalledWith('q-1', 'blk-1', { lineIds: ['l-2', 'l-1'] }));
  });
});
