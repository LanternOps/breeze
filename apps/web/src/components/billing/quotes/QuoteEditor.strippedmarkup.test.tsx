import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData, QuoteBlock } from './quoteTypes';
import { addBlock, updateBlock } from '../../../lib/api/quotes';

// Same house pattern as the sibling callout/table tests: swap the tiptap-backed
// RichTextEditor for a plain textarea so this test targets the add-block form
// wiring (notifyStrippedMarkup), not rich-text editing internals.
vi.mock('../../common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

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
  updateQuote: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

// okRes mirrors what a real block write now returns per issue #3520: a
// top-level `warnings` array alongside `data`, not just `{ data }`.
const okRes = (data: unknown, warnings?: unknown[]) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(warnings === undefined ? { data } : { data, warnings }),
  } as unknown as Response);

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
const updateBlockMock = vi.mocked(updateBlock);

const removedTagsWarning = (removedTags: string[]) => [{
  code: 'UNSUPPORTED_HTML_TAGS_REMOVED',
  field: 'content.html',
  removedTags,
}];

async function openRichTextForm() {
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-rich_text'));
  await waitFor(() => expect(screen.getByTestId('quote-block-rich-text-editor')).toBeInTheDocument());
}

describe('QuoteEditor — stripped-markup warning toast (#3520)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adding a rich_text block whose response carries warnings fires a warning toast naming the removed tags', async () => {
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-rt' }, removedTagsWarning(['blockquote', 'table'])));
    await openRichTextForm();

    fireEvent.change(screen.getByTestId('quote-block-rich-text-editor'), { target: { value: '<table><tr><td>x</td></tr></table>' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalled());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('table'),
    })));
    const warningCall = showToast.mock.calls.find((c) => (c[0] as { type: string }).type === 'warning');
    expect(warningCall?.[0]).toEqual(expect.objectContaining({ message: expect.stringContaining('blockquote') }));
  });

  it('adding a rich_text block whose response has an empty warnings array fires no warning toast', async () => {
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-rt2' }, []));
    await openRichTextForm();

    fireEvent.change(screen.getByTestId('quote-block-rich-text-editor'), { target: { value: '<p>Clean text</p>' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalled());
    // Give any (incorrect) async toast a chance to fire before asserting absence:
    // a successful add clears the draft textarea back to empty.
    await waitFor(() => expect(screen.getByTestId('quote-block-rich-text-editor')).toHaveValue(''));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });
});

// Case 3 (editing an existing block through updateBlock) is covered via the
// callout block's inline-edit form rather than rich_text: rich_text blocks in
// this editor have no inline "edit in place" affordance (only heading/table/
// callout/contract do — see the persisted-block branches in QuoteEditor.tsx),
// so wiring an inline rich_text edit here would require adding UI surface the
// component doesn't have. notifyStrippedMarkup wraps every parseSuccess
// (add AND update, across all block types) identically, so exercising it
// through updateBlock on a callout block proves the same wiring.
describe('QuoteEditor — stripped-markup warning toast on updateBlock (#3520)', () => {
  const calloutBlock: QuoteBlock = {
    id: 'blk-c', quoteId: 'q-1', orgId: 'org-1', blockType: 'callout',
    content: { variant: 'warn', title: 'Heads up', html: '<p>Read carefully</p>' },
    sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  };

  beforeEach(() => vi.clearAllMocks());

  it('editing a persisted block through updateBlock with a warnings-carrying response fires the warning toast', async () => {
    updateBlockMock.mockResolvedValue(okRes({ id: 'blk-c' }, removedTagsWarning(['h1'])));
    render(<QuoteEditor detail={{ ...detail, blocks: [calloutBlock] }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit'));
    fireEvent.change(screen.getByTestId('quote-block-callout-blk-c-edit-form-body'), { target: { value: '<h1>Revised</h1>' } });
    fireEvent.click(screen.getByTestId('quote-block-callout-blk-c-edit-save'));

    await waitFor(() => expect(updateBlockMock).toHaveBeenCalled());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('h1'),
    })));
  });
});
