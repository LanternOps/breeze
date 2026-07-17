import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { updateQuote, uploadQuoteImage } from '../../../lib/api/quotes';

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

vi.mock('../../../lib/api/contractTemplates', () => ({
  listContractTemplates: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  getContractTemplate: vi.fn(),
}));

const okRes = (data: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) } as unknown as Response);

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

const updateQuoteMock = vi.mocked(updateQuote);
const uploadMock = vi.mocked(uploadQuoteImage);

async function renderEditor(d: QuoteDetailData = detail) {
  const utils = render(<QuoteEditor detail={d} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  return utils;
}

describe('QuoteEditor — cover page panel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the cover page panel disabled by default', async () => {
    await renderEditor();
    expect(screen.getByTestId('quote-cover-page')).toBeInTheDocument();
    expect(screen.getByTestId('quote-cover-page-enabled')).not.toBeChecked();
    // Detail fields stay hidden until the cover page is enabled.
    expect(screen.queryByTestId('quote-cover-page-title')).not.toBeInTheDocument();
  });

  it('toggling the cover page on persists { enabled: true } via updateQuote', async () => {
    updateQuoteMock.mockResolvedValue(okRes({}));
    await renderEditor();

    fireEvent.click(screen.getByTestId('quote-cover-page-enabled'));

    await waitFor(() => expect(updateQuoteMock).toHaveBeenCalledWith('q-1', {
      coverPage: { enabled: true, showPreparedBy: true },
    }));
    // Detail fields reveal once enabled.
    expect(screen.getByTestId('quote-cover-page-title')).toBeInTheDocument();
  });

  it('editing the cover title persists it on blur, carrying enabled forward', async () => {
    updateQuoteMock.mockResolvedValue(okRes({}));
    await renderEditor({
      ...detail,
      quote: { ...detail.quote, coverPage: { enabled: true, showPreparedBy: true } },
    });

    const title = screen.getByTestId('quote-cover-page-title');
    fireEvent.change(title, { target: { value: 'Managed IT Proposal' } });
    fireEvent.blur(title);

    await waitFor(() => expect(updateQuoteMock).toHaveBeenCalledWith('q-1', {
      coverPage: { enabled: true, showPreparedBy: true, title: 'Managed IT Proposal' },
    }));
  });

  it('preserves un-blurred title keystrokes when an unrelated refetch lands (guarded resync)', async () => {
    updateQuoteMock.mockResolvedValue(okRes({}));
    const withCover: QuoteDetailData = {
      ...detail,
      quote: { ...detail.quote, coverPage: { enabled: true, showPreparedBy: true, title: 'Original' } },
    };
    const { rerender } = await renderEditor(withCover);

    const title = screen.getByTestId('quote-cover-page-title') as HTMLInputElement;
    // User types but has NOT blurred yet (no save fired).
    fireEvent.change(title, { target: { value: 'Half-typed draft' } });
    expect(title.value).toBe('Half-typed draft');

    // An unrelated save's refresh() re-passes a FRESH coverPage object (new
    // identity, same persisted content) — the mirror must not clobber the edit.
    rerender(<QuoteEditor detail={{
      ...withCover,
      quote: { ...withCover.quote, coverPage: { enabled: true, showPreparedBy: true, title: 'Original' } },
    }} onChanged={vi.fn()} />);

    expect((screen.getByTestId('quote-cover-page-title') as HTMLInputElement).value).toBe('Half-typed draft');
  });

  it('resyncs the title from the server when the value changed and the user has NOT diverged', async () => {
    const withCover: QuoteDetailData = {
      ...detail,
      quote: { ...detail.quote, coverPage: { enabled: true, showPreparedBy: true, title: 'Original' } },
    };
    const { rerender } = await renderEditor(withCover);
    expect((screen.getByTestId('quote-cover-page-title') as HTMLInputElement).value).toBe('Original');

    // No local edits → a changed server value flows through.
    rerender(<QuoteEditor detail={{
      ...withCover,
      quote: { ...withCover.quote, coverPage: { enabled: true, showPreparedBy: true, title: 'Server Updated' } },
    }} onChanged={vi.fn()} />);

    expect((screen.getByTestId('quote-cover-page-title') as HTMLInputElement).value).toBe('Server Updated');
  });

  it('uploading a cover image stores its imageId on the cover page', async () => {
    uploadMock.mockResolvedValue(okRes({ imageId: 'img-cov' }));
    updateQuoteMock.mockResolvedValue(okRes({}));
    await renderEditor({
      ...detail,
      quote: { ...detail.quote, coverPage: { enabled: true, showPreparedBy: true } },
    });

    const file = new File(['x'], 'cover.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('quote-cover-page-image-file'), { target: { files: [file] } });

    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith('q-1', file));
    await waitFor(() => expect(updateQuoteMock).toHaveBeenCalledWith('q-1', {
      coverPage: { enabled: true, showPreparedBy: true, coverImageId: 'img-cov' },
    }));
  });
});
