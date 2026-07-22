import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import * as quotesApi from '../../../lib/api/quotes';
import type { QuoteBlock, QuoteDetail as QuoteDetailData, QuoteLine } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';

vi.mock('../../../stores/auth', () => ({
  // orgStore (imported by QuoteEditor for the customer select) registers an
  // org-id provider against the auth store at module scope.
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
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
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const block: QuoteBlock = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Pricing' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};
const line: QuoteLine = {
  id: 'l-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: 'Onboarding', quantity: '1',
  unitPrice: '500.00', taxable: false, customerVisible: true, lineTotal: '500.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '500.00', taxRate: null,
    taxTotal: '0.00', total: '500.00', oneTimeTotal: '500.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [block],
  lines: [line],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async () => json({ data: {} }));
});

describe('QuoteEditor — block removal', () => {
  it('opens a confirm step naming the line count and does not delete on the first click', async () => {
    const deleteBlock = vi.mocked(quotesApi.deleteBlock);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    fireEvent.click(screen.getByTestId('quote-block-remove-blk-1'));

    const confirm = await screen.findByTestId('quote-block-remove-confirm');
    expect(confirm).toBeInTheDocument();
    // The cascade count must be surfaced to the user before they commit.
    expect(screen.getByText(/1 line item/)).toBeInTheDocument();
    // Nothing destroyed yet.
    expect(deleteBlock).not.toHaveBeenCalled();
  });

  it('deletes the block only after the confirm step (deferred through the undo grace window)', async () => {
    // Confirm hides the section immediately but DEFERS the DELETE for the
    // undo grace window — advance fake timers to flush it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const deleteBlock = vi.mocked(quotesApi.deleteBlock);
      deleteBlock.mockResolvedValue(json({ data: null }));

      render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
      fireEvent.click(screen.getByTestId('quote-block-remove-blk-1'));
      fireEvent.click(await screen.findByTestId('quote-block-remove-confirm'));

      // Optimistically gone (its lines with it), but nothing sent yet.
      expect(screen.queryByTestId('quote-block-container-blk-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('quote-line-l-1')).not.toBeInTheDocument();
      expect(deleteBlock).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(deleteBlock).toHaveBeenCalledWith('q-1', 'blk-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('undo within the grace window restores the section without any DELETE', async () => {
    const deleteBlock = vi.mocked(quotesApi.deleteBlock);
    const showToastMock = vi.mocked(showToast);

    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    fireEvent.click(screen.getByTestId('quote-block-remove-blk-1'));
    fireEvent.click(await screen.findByTestId('quote-block-remove-confirm'));
    expect(screen.queryByTestId('quote-block-container-blk-1')).not.toBeInTheDocument();

    const undoCall = [...showToastMock.mock.calls].reverse()
      .find((c) => (c[0] as { type: string }).type === 'undo');
    expect(undoCall).toBeDefined();
    act(() => { (undoCall![0] as { onUndo: () => void }).onUndo(); });

    expect(screen.getByTestId('quote-block-container-blk-1')).toBeInTheDocument();
    expect(screen.getByTestId('quote-line-l-1')).toBeInTheDocument();
    expect(deleteBlock).not.toHaveBeenCalled();
  });
});
