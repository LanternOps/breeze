import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';

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
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function draftDetail(extra: Partial<QuoteDetailData['quote']> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
      termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null,
      sentAt: null, viewedAt: null, createdBy: null,
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
      ...extra,
    },
    blocks: [],
    lines: [],
  };
}

describe('QuoteEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => json({ data: {} }));
  });

  it('editing the T&C textarea and blurring issues PATCH /quotes/:id with { termsAndConditions }', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input === '/quotes/q-1' && opts?.method === 'PATCH') return json({ data: {} });
      return json({ data: {} });
    });
    render(<QuoteEditor detail={draftDetail()} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const textarea = screen.getByTestId('quote-terms');
    fireEvent.change(textarea, { target: { value: 'Net 30' } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => c[0] === '/quotes/q-1' && (c[1] as RequestInit)?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toMatchObject({
        termsAndConditions: 'Net 30',
      });
    });
    // Per-field blur-saves are confirmed by the dirty-ring clearing (sighted) plus
    // the SrSaved live region (screen readers) — NOT a toast. Toasts are reserved
    // for action-level events; firing one per keystroke-blur was a storm that also
    // double-announced alongside the live region.
    await waitFor(() => expect(screen.getByTestId('quote-terms-saved')).toHaveTextContent('Saved'));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Saved' }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Terms saved' }));
  });

  it('editing the title and blurring issues PATCH /quotes/:id with { title }', async () => {
    render(<QuoteEditor detail={draftDetail()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const input = screen.getByTestId('quote-title');
    fireEvent.change(input, { target: { value: 'Office network refresh' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => c[0] === '/quotes/q-1' && (c[1] as RequestInit)?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toMatchObject({
        title: 'Office network refresh',
      });
    });
    await waitFor(() => expect(screen.getByTestId('quote-title-saved')).toHaveTextContent('Saved'));
  });

  it('debounces the screen-reader totals announcement to settle-time while visible figures stay live', async () => {
    vi.useFakeTimers();
    try {
      // Committed 10% rate: the rate itself is read-only in the editor, so the
      // optimism trigger below is a line-qty edit computed against it.
      const detail = draftDetail({ taxRate: '0.1' });
      detail.blocks = [
        { id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' },
      ];
      detail.lines = [
        {
          id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual', catalogItemId: null,
          parentLineId: null, name: 'Widget', description: null, quantity: '1', unitPrice: '100.00', unitCost: null,
          sku: null, partNumber: null, taxable: true, customerVisible: true, lineTotal: '100.00', recurrence: 'one_time',
          termMonths: null, billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
        },
      ];
      render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
      // Flush the mount-time catalog/distributor status fetches so their state
      // updates don't dangle into the assertions below.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const sr = screen.getByTestId('quote-totals-sr');
      // Right after mount the announcement is still empty (debounced), so a screen
      // reader isn't handed the sentence before the totals settle.
      expect(sr.textContent).toBe('');

      // The mount-time sentence is deliberately never announced — an SR user
      // who hasn't edited anything shouldn't be handed the initial totals.
      act(() => { vi.advanceTimersByTime(800); });
      expect(sr.textContent).toBe('');

      // Editing a line qty recomputes the VISIBLE figures immediately (2 × $100
      // taxable at the committed 10% rate → $220 due)…
      fireEvent.change(screen.getByTestId('quote-line-qty-l-1'), { target: { value: '2' } });
      expect(screen.getByTestId('quote-total-due-on-acceptance')).toHaveTextContent('$220.00');
      // …but the SR announcement stays silent until the edit settles.
      expect(sr.textContent).toBe('');

      // Before the settle window closes, still silent.
      act(() => { vi.advanceTimersByTime(700); });
      expect(sr.textContent).toBe('');

      // Once the window closes, the announcement catches up to the settled totals.
      act(() => { vi.advanceTimersByTime(100); });
      expect(sr).toHaveTextContent('tax $20.00');
      expect(sr).toHaveTextContent('due on acceptance $220.00');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the T&C textarea pre-filled with existing termsAndConditions', async () => {
    render(<QuoteEditor detail={draftDetail({ termsAndConditions: 'Payment due in 30 days' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const textarea = screen.getByTestId('quote-terms') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Payment due in 30 days');
  });
});
