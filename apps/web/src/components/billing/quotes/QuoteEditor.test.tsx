import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import { QuoteHeaderMeta } from './QuoteHeaderMeta';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';
import { listCatalog } from '../../../lib/api/catalog';
import { addCatalogLine } from '../../../lib/api/quotes';

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

vi.mock('../../../lib/api/catalog', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/catalog')>()),
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

/**
 * Records a probed element's committed DOM value. Layout effects run
 * synchronously in the mutation phase of the very commit that produced the
 * DOM, so this reads what the field actually showed at that commit without
 * depending on when React's scheduler gets around to passive effects — the
 * same technique used to pin down #4659 (AiBudgetThresholdsInput). It only
 * appends when THIS probe re-renders (a sibling of the field under test), so
 * an unconditional passive `useEffect` prop-sync — which re-seeds one commit
 * AFTER the render that already delivered the new prop — shows up as the
 * probe's commit still holding the STALE value; the render-phase reseed this
 * fix uses shows the new value already, in that same commit.
 */
function CommitProbe({ testId, seen }: { testId: string; seen: string[] }) {
  useLayoutEffect(() => {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) throw new Error(`CommitProbe: no element matching [data-testid="${testId}"]`);
    seen.push(el.value);
  });
  return null;
}

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
    // The editable title moved to the workspace header (QuoteHeaderMeta).
    render(<QuoteHeaderMeta detail={draftDetail()} onChanged={vi.fn()} />);

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

  // #4807 (mirrors #4659/#4033): `terms` used to re-seed from
  // `quote.termsAndConditions` in a `useEffect`, i.e. in a commit AFTER the
  // one that delivered the new prop. Because a passive effect is deferred, a
  // keystroke landing in that window was silently reverted by the stale
  // string the effect had captured. Re-seeding during render (this fix)
  // leaves no such commit — assert exactly that.
  it('re-seeds a changed termsAndConditions prop within the same commit, not a later one (#4807)', async () => {
    const seen: string[] = [];
    const view = (terms: string | null) => (
      <>
        <QuoteEditor detail={draftDetail({ termsAndConditions: terms })} onChanged={vi.fn()} />
        <CommitProbe testId="quote-terms" seen={seen} />
      </>
    );

    const { rerender } = render(view('Net 30'));
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    seen.length = 0;

    rerender(view('Net 45'));

    // One commit, already showing the new terms. An earlier entry still
    // reading 'Net 30' is the old effect-driven seed — the window that made
    // the field clobberable mid-keystroke.
    expect(seen).toEqual(['Net 45']);
  });

  // The deposit-percent draft has the identical shape: a live-typed numeric
  // field re-seeded from `quote.depositPercent` in a passive effect (#4807).
  it('re-seeds a changed depositPercent prop within the same commit, not a later one (#4807)', async () => {
    const seen: string[] = [];
    const view = (depositPercent: string | null) => (
      <>
        <QuoteEditor detail={draftDetail({ depositType: 'percent', depositPercent })} onChanged={vi.fn()} />
        <CommitProbe testId="deposit-percent-input" seen={seen} />
      </>
    );

    const { rerender } = render(view('10'));
    await waitFor(() => expect(screen.getByTestId('deposit-percent-input')).toBeInTheDocument());
    seen.length = 0;

    rerender(view('25'));

    expect(seen).toEqual(['25']);
  });

  // Discriminating test per the issue's required pattern: type a draft, then
  // let an unrelated (equal-valued) prop refetch land — the draft must
  // survive rather than being discarded by a resync that changed nothing.
  it('keeps a typed terms draft when an unrelated refetch hands back the same termsAndConditions', async () => {
    const detail = draftDetail({ termsAndConditions: 'Net 30' });
    const { rerender } = render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const textarea = screen.getByTestId('quote-terms') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Net 30 — draft in progress' } });

    // A fresh detail object, same persisted terms — an unrelated resync.
    rerender(<QuoteEditor detail={draftDetail({ termsAndConditions: 'Net 30' })} onChanged={vi.fn()} />);

    expect(textarea.value).toBe('Net 30 — draft in progress');
  });

  // Review finding: the reseed must also reset `termsDirty` when the prop
  // GENUINELY changes mid-edit (not just an equal-value refetch) — matching
  // what the old effect did — otherwise a stale "Unsaved" badge would linger
  // over text that was just replaced with the (already-persisted) new value.
  it('clears the Unsaved badge when a genuinely different termsAndConditions prop lands mid-edit', async () => {
    const { rerender } = render(<QuoteEditor detail={draftDetail({ termsAndConditions: 'Net 30' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const textarea = screen.getByTestId('quote-terms') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Net 30 draft' } });
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();

    // A genuinely different persisted value lands (e.g. another session's edit).
    rerender(<QuoteEditor detail={draftDetail({ termsAndConditions: 'Net 60' })} onChanged={vi.fn()} />);

    expect(textarea.value).toBe('Net 60');
    expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument();
  });

  // Review finding: the deposit-percent reseed clears `depositPctError` too
  // (new behavior vs. the old effect, which never touched it) — a stale
  // "out of range" message must not linger once the field has been replaced
  // with a fresh, valid, server-confirmed value.
  it('clears the inline deposit-percent range error when a genuinely different depositPercent prop lands', async () => {
    const { rerender } = render(
      <QuoteEditor detail={draftDetail({ depositType: 'percent', depositPercent: '10' })} onChanged={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('deposit-percent-input')).toBeInTheDocument());

    const input = screen.getByTestId('deposit-percent-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('deposit-percent-error')).toBeInTheDocument();

    rerender(<QuoteEditor detail={draftDetail({ depositType: 'percent', depositPercent: '30' })} onChanged={vi.fn()} />);

    expect(input.value).toBe('30');
    expect(screen.queryByTestId('deposit-percent-error')).not.toBeInTheDocument();
  });

  it('toasts the currency-gap message when the catalog add answers NO_PRICE_FOR_CURRENCY (#3775)', async () => {
    const catItem = {
      id: 'cat-1', partnerId: 'p-1', itemType: 'hardware', name: 'NVMe 1TB', sku: 'NV-1', description: null,
      billingType: 'one_time', unitPrice: '150.00', costBasis: null, costCurrency: 'USD', markupPercent: null,
      unitOfMeasure: 'each', taxable: false, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '',
      prices: [{ currencyCode: 'USD', unitPrice: '150.00' }],
    };
    vi.mocked(listCatalog).mockResolvedValueOnce(json({ data: [catItem] }));
    vi.mocked(addCatalogLine).mockResolvedValueOnce(
      json({ error: 'No price in EUR', code: 'NO_PRICE_FOR_CURRENCY' }, false, 409),
    );
    const detail = draftDetail({ currencyCode: 'EUR' });
    detail.blocks = [
      { id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' },
    ];
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-block-add-catalog-b-1'));
    fireEvent.click(screen.getByTestId('quote-block-add-catalog-b-1'));

    // The picker renders the EUR gap (not the USD row, not the unitPrice mirror)…
    fireEvent.change(await screen.findByTestId('quote-catalog-picker-b-1-input'), { target: { value: 'NV' } });
    expect(await screen.findByTestId('quote-catalog-picker-b-1-noprice-cat-1')).toHaveTextContent('No EUR price');
    // …but the item stays selectable; the server answers the gap and the editor names the currency.
    fireEvent.click(screen.getByTestId('quote-catalog-picker-b-1-option-cat-1'));

    await waitFor(() => expect(addCatalogLine).toHaveBeenCalledWith('q-1', expect.objectContaining({ catalogItemId: 'cat-1', blockId: 'b-1' })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'No EUR price for this item. Add one in the catalog or enter a manual line.',
    })));
  });
});
