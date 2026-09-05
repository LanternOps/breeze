/**
 * Regression suite for #4286 — the line-creation twin of #3519's block-strand
 * defect (see QuoteEditor.blockcreatestrand.test.tsx).
 *
 * Same mechanism, worse outcome: `doAddCatalog` and `addManual` deliberately
 * have NO success toast ("the new row visibly appears and the totals move"
 * IS the signal), and that signal only exists when the parent's *quiet*
 * refetch lands. A quiet refetch that fails after a successful line POST left
 * the operator staring at a canvas with no new row and no toast — indistin-
 * guishable from "nothing happened" — so they re-added the same line,
 * duplicating a billable charge. A duplicated billable line is a worse
 * outcome than #3519's duplicated image block.
 *
 * These tests pin both directions for BOTH call sites (catalog-item add and
 * manual-line add):
 *  - success direction: the line POST landed but the quiet resync never did
 *    → the user must still be told the line exists and the list is stale;
 *  - failure direction: the line POST itself failed → the user must get the
 *    real error, never the "added" copy (guards against over-reporting).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { addCatalogLine, addManualLine } from '../../../lib/api/quotes';
import { createCatalogItem } from '../../../lib/api/catalog';

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

vi.mock('../../../lib/api/catalog', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/catalog')>()),
  listCatalog: vi.fn().mockResolvedValue(
    {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        data: [{
          id: 'cat-1', partnerId: 'p-1', itemType: 'hardware', name: 'NVMe 1TB', sku: 'NV-1', description: null,
          billingType: 'one_time', unitPrice: '150.00', costBasis: null, costCurrency: 'USD', markupPercent: null,
          unitOfMeasure: 'each', taxable: false, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '',
          prices: [{ currencyCode: 'USD', unitPrice: '150.00' }],
        }],
      }),
    } as unknown as Response,
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
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  reorderBlocks: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const okRes = (data: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) } as unknown as Response);
const errRes = () =>
  ({ ok: false, status: 502, statusText: 'Bad Gateway', json: vi.fn().mockResolvedValue({ error: 'upstream exploded' }) } as unknown as Response);

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
    taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [block],
  lines: [],
};

const addCatalogLineMock = vi.mocked(addCatalogLine);
const addManualLineMock = vi.mocked(addManualLine);
const createCatalogItemMock = vi.mocked(createCatalogItem);

const toastMessages = () =>
  showToast.mock.calls.map((c) => (c[0] as { message: string }).message);

async function mountEditor(onChanged: () => unknown) {
  render(<QuoteEditor detail={detail} onChanged={onChanged as () => void} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
}

async function submitCatalogLine() {
  fireEvent.click(screen.getByTestId('quote-block-add-catalog-blk-1'));
  fireEvent.change(await screen.findByTestId('quote-catalog-picker-blk-1-input'), { target: { value: 'NV' } });
  fireEvent.click(await screen.findByTestId('quote-catalog-picker-blk-1-option-cat-1'));
}

async function submitManualLine() {
  fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));
  fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));
  fireEvent.change(screen.getByTestId('quote-manual-name-blk-1'), { target: { value: 'On-site setup' } });
  fireEvent.click(screen.getByTestId('quote-manual-add-blk-1'));
}

describe('QuoteEditor — a catalog/manual line created server-side is never silently stranded (#4286)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('catalog add: tells the user the line was added when the list refetch never lands', async () => {
    addCatalogLineMock.mockResolvedValue(okRes({ id: 'line-new' }));
    // The line EXISTS server-side, but the parent's quiet refetch fails, so
    // `detail` never changes and the list stays empty — the reported production
    // state that invites a duplicate re-add.
    const onChanged = vi.fn().mockResolvedValue(false);

    await mountEditor(onChanged);
    await submitCatalogLine();

    await waitFor(() => expect(addCatalogLineMock).toHaveBeenCalledTimes(1));
    // Assert the exact resolved copy, not just /added/i — the block-strand
    // fix's `sectionAddedListStale` string also matches that loose regex, and
    // a copy-paste that toasted the wrong locale key would still pass a loose
    // "contains added" check (verified: swapping in `sectionAddedListStale`
    // here left the loose assertion green).
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Line added, but the list could not refresh. Reload the page to see it.', type: 'warning' }),
    ));
  });

  it('catalog add: still reports the stale-list warning (not a generic add failure) when the resync throws outright', async () => {
    addCatalogLineMock.mockResolvedValue(okRes({ id: 'line-new' }));
    const onChanged = vi.fn().mockRejectedValue(new Error('network gone'));

    await mountEditor(onChanged);
    await submitCatalogLine();

    await waitFor(() => expect(addCatalogLineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Line added, but the list could not refresh. Reload the page to see it.', type: 'warning' }),
    ));
  });

  it('catalog add: a genuine create failure still reports the real error, not "added"', async () => {
    // Guard against over-reporting: the line was NEVER created, so the user
    // must get the failure, not an "added" notice.
    addCatalogLineMock.mockResolvedValue(errRes());
    const onChanged = vi.fn().mockResolvedValue(true);

    await mountEditor(onChanged);
    await submitCatalogLine();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'upstream exploded', type: 'error' }),
    ));
    expect(toastMessages().join(' | ')).not.toMatch(/added/i);
  });

  it('catalog add: stays quiet on the happy path — a landed resync is still the success signal', async () => {
    addCatalogLineMock.mockResolvedValue(okRes({ id: 'line-new' }));
    const onChanged = vi.fn().mockResolvedValue(true);

    await mountEditor(onChanged);
    await submitCatalogLine();

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
  });

  it('manual add: tells the user the line was added when the list refetch never lands', async () => {
    addManualLineMock.mockResolvedValue(okRes({ id: 'line-new' }));
    const onChanged = vi.fn().mockResolvedValue(false);

    await mountEditor(onChanged);
    await submitManualLine();

    await waitFor(() => expect(addManualLineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Line added, but the list could not refresh. Reload the page to see it.', type: 'warning' }),
    ));
  });

  it('manual add: a genuine create failure still reports the real error, not "added"', async () => {
    addManualLineMock.mockResolvedValue(errRes());
    const onChanged = vi.fn().mockResolvedValue(true);

    await mountEditor(onChanged);
    await submitManualLine();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'upstream exploded', type: 'error' }),
    ));
    expect(toastMessages().join(' | ')).not.toMatch(/added/i);
  });

  it('manual add: stays quiet on the happy path — a landed resync is still the success signal', async () => {
    addManualLineMock.mockResolvedValue(okRes({ id: 'line-new' }));
    const onChanged = vi.fn().mockResolvedValue(true);

    await mountEditor(onChanged);
    await submitManualLine();

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
  });

  it('manual add: still reports the stale-list warning (not a generic add failure) when the resync throws outright', async () => {
    addManualLineMock.mockResolvedValue(okRes({ id: 'line-new' }));
    const onChanged = vi.fn().mockRejectedValue(new Error('network gone'));

    await mountEditor(onChanged);
    await submitManualLine();

    await waitFor(() => expect(addManualLineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Line added, but the list could not refresh. Reload the page to see it.', type: 'warning' }),
    ));
  });

  it('manual add: a failed catalog-save still resyncs the canvas rather than skipping it (the line already exists)', async () => {
    // The line POST succeeds — the line EXISTS server-side — but the optional
    // "save to catalog" follow-up fails. Before the fix, that failing
    // `runAction` threw past the (then-unconditional) `finishLineCreate()`
    // call entirely, so the canvas was left un-resynced with no stale-list
    // warning on top of runAction's own "saving to catalog failed" toast —
    // strictly worse than the plain fire-and-forget `refresh()` this PR
    // replaces. The fix wraps the optional catalog-save in a `finally` so the
    // resync always runs once the line itself is known to exist.
    addManualLineMock.mockResolvedValue(okRes({ id: 'line-new' }));
    createCatalogItemMock.mockResolvedValue(errRes());
    const onChanged = vi.fn().mockResolvedValue(true);

    await mountEditor(onChanged);
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));
    fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));
    fireEvent.change(screen.getByTestId('quote-manual-name-blk-1'), { target: { value: 'On-site setup' } });
    fireEvent.click(screen.getByTestId('quote-manual-save-catalog-blk-1'));
    fireEvent.click(screen.getByTestId('quote-manual-add-blk-1'));

    await waitFor(() => expect(addManualLineMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createCatalogItemMock).toHaveBeenCalledTimes(1));
    // The resync ran despite the catalog-save failure — this is the assertion
    // that would fail without the `finally` wrapper.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // errRes()'s body carries a literal `error` string, which extractApiError
    // surfaces verbatim over the `lineAddedCatalogSaveFailed` fallback — same
    // contract the catalog-add "genuine create failure" test above relies on.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'upstream exploded', type: 'error' }),
    ));
    // No contradictory "could not add the line" — the line itself succeeded.
    expect(toastMessages().join(' | ')).not.toMatch(/could not add the line/i);
  });
});
