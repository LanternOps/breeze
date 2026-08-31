/**
 * Regression suite for #3519 — "Quote image upload can create blocks server-side
 * while the editor shows nothing".
 *
 * The stranding mechanism: an image block's ONLY success signal is the block
 * appearing in the list ("No success toast — the image block visibly appears"),
 * and that list only moves when the parent's *quiet* refetch lands. A quiet
 * refetch that fails is swallowed by design, so the user saw: block created
 * server-side, zero toast, an empty list, and a submit button that had gone
 * disabled again because the form reset — indistinguishable from "still
 * uploading". They re-uploaded, four times, into ~10 duplicate blocks.
 *
 * These tests pin BOTH directions of the post-create tail:
 *  - success direction: the create landed but the list never resynced → the
 *    user must still be told the section exists;
 *  - failure direction: something after the create failed → the user must NOT
 *    be told "could not add the section" (the copy that invites a re-submit).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { addBlock, uploadQuoteImage } from '../../../lib/api/quotes';

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
  blocks: [],
  lines: [],
};

const addBlockMock = vi.mocked(addBlock);
const uploadMock = vi.mocked(uploadQuoteImage);

/** Mount the editor with a parent whose refetch behaviour the test controls,
 *  pick the image block type, and attach a file — i.e. the exact state the
 *  reporter was in when they hit "Upload & add image". */
async function armImageUpload(onChanged: () => unknown) {
  render(<QuoteEditor detail={detail} onChanged={onChanged as () => void} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-image'));
  const file = new File(['bytes'], 'diagram.png', { type: 'image/png' });
  fireEvent.change(screen.getByTestId('quote-block-image-file'), { target: { files: [file] } });
  return file;
}

const toastMessages = () =>
  showToast.mock.calls.map((c) => (c[0] as { message: string }).message);

describe('QuoteEditor — an image block created server-side is never invisible (#3519)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tells the user the section was added when the list refetch never lands', async () => {
    // Both mutations succeed — the block EXISTS server-side from here on.
    uploadMock.mockResolvedValue(okRes({ imageId: 'img-1' }));
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-new' }));
    // ...but the parent's quiet refetch fails, so `detail` never changes and the
    // block list stays empty. This is the reported production state.
    const onChanged = vi.fn().mockResolvedValue(false);

    await armImageUpload(onChanged);
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    // The editor genuinely shows nothing — that is the bug's premise, not an
    // artifact: the empty-state placeholder is still the only thing rendered.
    expect(screen.getByTestId('quote-blocks-empty')).toBeInTheDocument();

    // ...so silence here is what made the reporter re-upload. The user must be
    // told the section exists and that the view is stale.
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(toastMessages().join(' | ')).toMatch(/added/i);
    // And it must not be the copy that invites a re-submit.
    expect(toastMessages().join(' | ')).not.toMatch(/could not add/i);
  });

  it('does not report "could not add the image section" when the create succeeded and only the resync failed', async () => {
    uploadMock.mockResolvedValue(okRes({ imageId: 'img-1' }));
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-new' }));
    // The refetch throws outright (network drop mid-resync) rather than
    // resolving false — the post-create tail must still land on the honest
    // outcome instead of the generic add-failed toast or total silence.
    const onChanged = vi.fn().mockRejectedValue(new Error('network gone'));

    await armImageUpload(onChanged);
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(showToast).toHaveBeenCalled());

    const joined = toastMessages().join(' | ');
    expect(joined).toMatch(/added/i);
    expect(joined).not.toMatch(/could not add the image section/i);
    // The button unlatches so the editor is usable again (a fresh file re-arms it).
    await waitFor(() => expect(screen.getByTestId('quote-add-block-submit')).toBeDisabled());
    // NOT asserted here, deliberately: that the uncontrolled file input's own
    // `.value` was cleared. jsdom never populates `value` from a programmatic
    // `files` assignment (measured: with the DOM reset deleted, `.value` is
    // still ''), and a file input's value cannot be set to a non-empty string,
    // so any assertion on it passes whether or not the reset exists. Shipping
    // one would claim coverage this layer cannot give. The DOM reset is covered
    // by inspection; proving it needs a real browser (Playwright).
    const retry = new File(['more'], 'again.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('quote-block-image-file'), { target: { files: [retry] } });
    expect(screen.getByTestId('quote-add-block-submit')).toBeEnabled();
  });

  it('still reports a genuine pre-create failure as a failure, and adds no block', async () => {
    // Guard against the fix over-reporting: when the block was NEVER created the
    // user must get the error, not an "added" notice.
    uploadMock.mockResolvedValue(okRes({ imageId: 'img-1' }));
    addBlockMock.mockResolvedValue(errRes());
    const onChanged = vi.fn().mockResolvedValue(true);

    await armImageUpload(onChanged);
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'upstream exploded', type: 'error' }),
    ));
    expect(toastMessages().join(' | ')).not.toMatch(/added/i);
    // Nothing was created, so the form keeps the file and the button stays live.
    expect(screen.getByTestId('quote-add-block-submit')).toBeEnabled();
  });

  it('stays quiet on the happy path — a landed resync is still the success signal', async () => {
    uploadMock.mockResolvedValue(okRes({ imageId: 'img-1' }));
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-new' }));
    const onChanged = vi.fn().mockResolvedValue(true);

    await armImageUpload(onChanged);
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
  });
});
