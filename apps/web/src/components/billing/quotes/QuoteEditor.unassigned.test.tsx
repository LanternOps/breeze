// The orphan bucket: `quote_lines.block_id` is nullable, and a line with a NULL
// block_id renders on every customer-facing surface (PDF, portal, Preview) and
// counts in every total — but the editor drew blocks only, so it was money on a
// real quote that the builder refused to show. These tests pin the bucket's
// three load-bearing behaviours: it appears for an orphan, it is completely
// absent without one, and its move actually PATCHes the move endpoint and
// surfaces the outcome.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { moveLine } from '../../../lib/api/quotes';

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
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  updateQuote: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const mkTable = (id: string, sortOrder: number, label?: string): QuoteDetailData['blocks'][number] => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: label ? { label } : {}, sortOrder, createdAt: '2026-06-01T00:00:00Z',
});

// blockId is deliberately typed `string | null` here — a null is the whole
// point of the fixture (this is the shape the API really returns).
const mkLine = (id: string, blockId: string | null, sortOrder: number, overrides: Partial<QuoteDetailData['lines'][number]> = {}): QuoteDetailData['lines'][number] => ({
  id, quoteId: 'q-1', blockId, orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: `Line ${id}`, quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder,
  createdAt: '2026-06-01T00:00:00Z', ...overrides,
});

const quote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '92.00', taxRate: null,
  taxTotal: '0.00', total: '92.00', oneTimeTotal: '92.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

// The shape that shipped a $42 line onto a real customer quote: one healthy
// pricing panel, plus one line with no block at all.
const withOrphan: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services')],
  lines: [
    mkLine('l-1', 'blk-1', 0),
    mkLine('orphan-1', null, 1, { name: 'Rush shipping', unitPrice: '42.00', lineTotal: '42.00' }),
  ],
};

const healthy: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services')],
  lines: [mkLine('l-1', 'blk-1', 0)],
};

const moveLineMock = vi.mocked(moveLine);

const renderEditor = async (detail: QuoteDetailData, onChanged = vi.fn()) => {
  render(<QuoteEditor detail={detail} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  return onChanged;
};

describe('QuoteEditor — unassigned (orphan) lines bucket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moveLineMock.mockResolvedValue(okResponse());
  });

  it('renders an orphan line in the bucket, with its money', async () => {
    await renderEditor(withOrphan);

    const bucket = screen.getByTestId('quote-unassigned-lines');
    const row = within(bucket).getByTestId('quote-unassigned-line-orphan-1');
    expect(row).toHaveTextContent('Rush shipping');
    expect(row).toHaveTextContent('$42.00');
  });

  it('states that the lines are on the customer quote and in the total', async () => {
    await renderEditor(withOrphan);

    // This copy IS the fix — an orphan the tech reads as cosmetic ships anyway.
    const explainer = screen.getByTestId('quote-unassigned-explainer');
    expect(explainer).toHaveTextContent('appear on the customer’s quote');
    expect(explainer).toHaveTextContent('count toward its totals');
  });

  it('renders nothing at all when the quote has no orphan lines', async () => {
    await renderEditor(healthy);

    expect(screen.queryByTestId('quote-unassigned-lines')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-unassigned-explainer')).not.toBeInTheDocument();
    // The healthy quote still renders its pricing panel — the bucket's absence
    // is not the editor failing to render.
    expect(screen.getByTestId('quote-block-lines-blk-1')).toBeInTheDocument();
  });

  it('offers every pricing panel as a move target', async () => {
    await renderEditor({
      ...withOrphan,
      blocks: [mkTable('blk-1', 0, 'Services'), mkTable('blk-2', 1)],
    });

    const select = screen.getByTestId('quote-unassigned-move-orphan-1');
    expect(within(select).getByRole('option', { name: 'Services' })).toBeInTheDocument();
    // Unlabeled panels fall back to the editor's positional name.
    expect(within(select).getByRole('option', { name: 'Pricing table 2' })).toBeInTheDocument();
  });

  it('PATCHes the move endpoint with the chosen block and adopts the line', async () => {
    const onChanged = await renderEditor(withOrphan);

    fireEvent.change(screen.getByTestId('quote-unassigned-move-orphan-1'), { target: { value: 'blk-1' } });

    await waitFor(() => expect(moveLineMock).toHaveBeenCalledWith('q-1', 'orphan-1', { blockId: 'blk-1' }));
    // Optimistic: the line is now in the real panel and out of the bucket —
    // and with no orphans left the bucket removes itself entirely.
    const panel = screen.getByTestId('quote-block-lines-blk-1');
    expect(within(panel).getByTestId('quote-line-qty-orphan-1')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-unassigned-lines')).not.toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('surfaces a failed move and puts the line back in the bucket', async () => {
    moveLineMock.mockResolvedValue(
      { ok: false, status: 500, statusText: 'err', json: vi.fn().mockResolvedValue({ error: 'boom' }) } as unknown as Response,
    );
    await renderEditor(withOrphan);

    fireEvent.change(screen.getByTestId('quote-unassigned-move-orphan-1'), { target: { value: 'blk-1' } });

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() =>
      expect(screen.getByTestId('quote-unassigned-line-orphan-1')).toBeInTheDocument());
  });

  it('tells the tech to add a pricing section when there is nowhere to move to', async () => {
    await renderEditor({ ...withOrphan, blocks: [], lines: [withOrphan.lines[1]] });

    expect(screen.getByTestId('quote-unassigned-lines')).toBeInTheDocument();
    expect(screen.getByTestId('quote-unassigned-no-targets')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-unassigned-move-orphan-1')).not.toBeInTheDocument();
  });
});
