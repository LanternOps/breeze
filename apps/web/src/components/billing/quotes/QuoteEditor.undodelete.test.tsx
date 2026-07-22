import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import * as quotesApi from '../../../lib/api/quotes';
import type { QuoteDetail as QuoteDetailData, QuoteLine } from './quoteTypes';

// Writer permissions so the inline line editor + menus render.
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
}));

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  reorderLines: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const okJson = (payload: unknown = { data: {} }): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const failJson = (): Response =>
  ({ ok: false, status: 500, statusText: 'ERR', json: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) }) as unknown as Response;

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Pricing' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const mkLine = (id: string, price: string, cost: string | null, sortOrder: number): QuoteLine => ({
  id, quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: cost, sku: null, partNumber: null,
  name: `Item ${id}`, description: null, quantity: '1.00',
  unitPrice: price, taxable: false, customerVisible: true, lineTotal: price,
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder,
  createdAt: '2026-06-01T00:00:00Z',
});

// l-1 deliberately has NO cost (feeds the missing-cost notice); server totals
// include all three lines, so the optimistic recompute after a delete is
// observable against them.
const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '600.00', taxRate: null,
    taxTotal: '0.00', total: '600.00', oneTimeTotal: '600.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [block],
  lines: [mkLine('l-1', '100.00', null, 0), mkLine('l-2', '200.00', '50.00', 1), mkLine('l-3', '300.00', '75.00', 2)],
};

const removeLineMock = vi.mocked(quotesApi.removeLine);

async function renderEditor(props: Partial<Parameters<typeof QuoteEditor>[0]> = {}) {
  const utils = render(<QuoteEditor detail={detail} onChanged={vi.fn()} {...props} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  return utils;
}

async function deleteLineViaMenu(id: string) {
  fireEvent.click(screen.getByTestId(`quote-line-actions-${id}`));
  fireEvent.click(screen.getByTestId(`quote-line-remove-${id}`));
  fireEvent.click(await screen.findByTestId('quote-line-remove-confirm'));
}

/** The undo callback of the most recent undo-type toast. */
function lastUndo(): () => void {
  const call = [...showToast.mock.calls].reverse()
    .find((c) => (c[0] as { type: string }).type === 'undo');
  expect(call).toBeDefined();
  return (call![0] as { onUndo: () => void }).onUndo;
}

const visibleRowIds = () =>
  screen.queryAllByTestId(/^quote-line-l-\d$/).map((el) => el.getAttribute('data-testid'));

describe('QuoteEditor — undo-able line deletion (grace window)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    removeLineMock.mockResolvedValue(okJson());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the row optimistically, recomputes totals, and sends no DELETE inside the window', async () => {
    await renderEditor();
    expect(screen.getByTestId('quote-total-grand').textContent).toBe('$600.00');

    await deleteLineViaMenu('l-2');

    // Row gone instantly, totals recomputed from the remaining lines…
    expect(screen.queryByTestId('quote-line-l-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-total-grand').textContent).toBe('$400.00');
    // …but the server has not been told yet.
    expect(removeLineMock).not.toHaveBeenCalled();
    // The undo toast fired with the grace-window duration.
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'undo', duration: 6000 }));
  });

  it('undo restores the line at its exact position with zero DELETE calls', async () => {
    await renderEditor();
    await deleteLineViaMenu('l-2');
    expect(visibleRowIds()).toEqual(['quote-line-l-1', 'quote-line-l-3']);

    act(() => { lastUndo()(); });

    expect(visibleRowIds()).toEqual(['quote-line-l-1', 'quote-line-l-2', 'quote-line-l-3']);
    expect(screen.getByTestId('quote-total-grand').textContent).toBe('$600.00');
    expect(removeLineMock).not.toHaveBeenCalled();
  });

  it('fires the real DELETE through the existing path when the window expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onChanged = vi.fn();
    await renderEditor({ onChanged });
    await deleteLineViaMenu('l-2');
    expect(removeLineMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    expect(removeLineMock).toHaveBeenCalledWith('q-1', 'l-2');
    // The existing delete path still refreshes so server totals resync.
    expect(onChanged).toHaveBeenCalled();
    // Row stays hidden while we wait for the refetch to drop it.
    expect(screen.queryByTestId('quote-line-l-2')).not.toBeInTheDocument();
  });

  it('restores the line and surfaces the error when the deferred DELETE fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    removeLineMock.mockResolvedValue(failJson());
    await renderEditor();
    await deleteLineViaMenu('l-2');
    expect(screen.queryByTestId('quote-line-l-2')).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    // Honest failure: the DELETE didn't land, so the line is really still
    // there — back on screen, error toasted by the existing path.
    expect(screen.getByTestId('quote-line-l-2')).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(screen.getByTestId('quote-total-grand').textContent).toBe('$600.00');
  });

  it('counts as a pending edit and the registered flush fires the DELETE immediately (Send path)', async () => {
    let flush: (() => void) | null = null;
    const onPendingEditsChange = vi.fn();
    await renderEditor({
      onPendingEditsChange,
      onRegisterPendingDeleteFlush: (fn) => { flush = fn; },
    });
    onPendingEditsChange.mockClear();

    await deleteLineViaMenu('l-2');
    // Send-hold plumbing: a deferred deletion reports as a pending edit.
    expect(onPendingEditsChange).toHaveBeenLastCalledWith(true);
    expect(removeLineMock).not.toHaveBeenCalled();

    // Send clicked mid-window → the workspace calls the registered flush; the
    // DELETE goes out now instead of waiting out the rest of the window.
    expect(flush).not.toBeNull();
    act(() => { flush!(); });
    await waitFor(() => expect(removeLineMock).toHaveBeenCalledWith('q-1', 'l-2'));
    expect(removeLineMock).toHaveBeenCalledTimes(1);
  });

  it('excludes a pending-deleted line from bulk selection and the missing-cost notice', async () => {
    await renderEditor();
    // Reveal internal economics so the missing-cost notice renders (l-1 has no cost).
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));
    expect(screen.getByTestId('quote-margin-missing-cost')).toBeInTheDocument();
    // Select the line → bulk bar appears.
    fireEvent.click(screen.getByTestId('quote-line-select-l-1'));
    expect(screen.getByTestId('quote-bulk-bar')).toBeInTheDocument();

    await deleteLineViaMenu('l-1');

    // Selection pruned (bar gone) and the missing-cost notice no longer counts
    // the hidden line.
    expect(screen.queryByTestId('quote-bulk-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-margin-missing-cost')).not.toBeInTheDocument();
    expect(removeLineMock).not.toHaveBeenCalled();
  });

  it('flushes a pending deletion on unmount', async () => {
    const { unmount } = await renderEditor();
    await deleteLineViaMenu('l-2');
    expect(removeLineMock).not.toHaveBeenCalled();

    unmount();

    await waitFor(() => expect(removeLineMock).toHaveBeenCalledWith('q-1', 'l-2'));
  });
});
