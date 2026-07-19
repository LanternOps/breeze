import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData, QuoteBlock, QuoteLine } from './quoteTypes';
import { addBlock, addQuoteImageFromUrl, updateLine } from '../../../lib/api/quotes';

vi.mock('../../../stores/auth', () => ({
  // orgStore (imported by QuoteEditor for the customer select) registers an
  // org-id provider against the auth store at module scope.
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
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const okRes = (data: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) } as unknown as Response);
const errRes = () =>
  ({ ok: false, status: 502, statusText: 'Bad Gateway', json: vi.fn().mockResolvedValue({ error: 'x' }) } as unknown as Response);

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
const fromUrlMock = vi.mocked(addQuoteImageFromUrl);
const updateLineMock = vi.mocked(updateLine);

// A pricing table + one manual line, so the per-line image controls render.
const lineBlock: QuoteBlock = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};
const manualLine: QuoteLine = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, imageId: null, parentLineId: null, unitCost: null, sku: null,
  partNumber: null, name: 'Widget', description: null, quantity: '1', unitPrice: '10.00',
  taxable: true, customerVisible: true, lineTotal: '10.00', recurrence: 'one_time',
  termMonths: null, billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};
const detailWithLine: QuoteDetailData = { ...detail, blocks: [lineBlock], lines: [manualLine] };

async function openImageUrlPanel() {
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-image'));
  fireEvent.click(screen.getByTestId('quote-block-image-source-url'));
}

describe('QuoteEditor — add image from URL', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the URL input and hides the file input when "From URL" is selected', async () => {
    await openImageUrlPanel();
    expect(screen.getByTestId('quote-block-image-url')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-image-file')).not.toBeInTheDocument();
  });

  it('submitting a URL copies the image then adds an image block with the returned id', async () => {
    fromUrlMock.mockResolvedValue(okRes({ imageId: 'img-1' }));
    addBlockMock.mockResolvedValue(okRes({}));
    await openImageUrlPanel();

    fireEvent.change(screen.getByTestId('quote-block-image-url'), { target: { value: 'https://cdn.example.com/a.png' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(fromUrlMock).toHaveBeenCalledWith('q-1', 'https://cdn.example.com/a.png'));
    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'image', content: { imageId: 'img-1' },
    }));
  });

  it('a failed fetch shows an error toast and adds no block', async () => {
    fromUrlMock.mockResolvedValue(errRes());
    await openImageUrlPanel();

    fireEvent.change(screen.getByTestId('quote-block-image-url'), { target: { value: 'https://internal/a.png' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'x', type: 'error' })));
    expect(addBlockMock).not.toHaveBeenCalled();
  });

  it('disables submit while the URL is empty', async () => {
    await openImageUrlPanel();
    expect(screen.getByTestId('quote-add-block-submit')).toBeDisabled();
  });

  it('switching back to "Upload file" hides the URL input and shows the file input again', async () => {
    await openImageUrlPanel();
    expect(screen.getByTestId('quote-block-image-url')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('quote-block-image-source-file'));

    expect(screen.queryByTestId('quote-block-image-url')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-block-image-file')).toBeInTheDocument();
  });
});

describe('QuoteEditor — add line image from URL', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderWithLine() {
    render(<QuoteEditor detail={detailWithLine} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-line-line-1')).toBeInTheDocument());
  }

  it('the URL field is hidden until "From URL" is clicked', async () => {
    await renderWithLine();
    expect(screen.queryByTestId('quote-line-image-url-input-line-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-image-url-toggle-line-1'));
    expect(screen.getByTestId('quote-line-image-url-input-line-1')).toBeInTheDocument();
  });

  it('fetching a URL copies the image then PATCHes the line with the returned id', async () => {
    fromUrlMock.mockResolvedValue(okRes({ imageId: 'img-9' }));
    updateLineMock.mockResolvedValue(okRes({}));
    await renderWithLine();

    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-image-url-toggle-line-1'));
    fireEvent.change(screen.getByTestId('quote-line-image-url-input-line-1'), { target: { value: 'https://cdn.example.com/w.png' } });
    fireEvent.click(screen.getByTestId('quote-line-image-url-fetch-line-1'));

    await waitFor(() => expect(fromUrlMock).toHaveBeenCalledWith('q-1', 'https://cdn.example.com/w.png'));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { imageId: 'img-9' }));
    // Success collapses the disclosure back to hidden.
    await waitFor(() => expect(screen.queryByTestId('quote-line-image-url-input-line-1')).not.toBeInTheDocument());
  });

  it('Fetch is disabled until a URL is entered', async () => {
    await renderWithLine();
    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-image-url-toggle-line-1'));
    expect(screen.getByTestId('quote-line-image-url-fetch-line-1')).toBeDisabled();
    fireEvent.change(screen.getByTestId('quote-line-image-url-input-line-1'), { target: { value: 'https://x/y.png' } });
    expect(screen.getByTestId('quote-line-image-url-fetch-line-1')).toBeEnabled();
  });

  it('a failed fetch toasts, does not PATCH, and keeps the URL open for retry', async () => {
    fromUrlMock.mockResolvedValue(errRes());
    await renderWithLine();

    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-image-url-toggle-line-1'));
    fireEvent.change(screen.getByTestId('quote-line-image-url-input-line-1'), { target: { value: 'https://internal/w.png' } });
    fireEvent.click(screen.getByTestId('quote-line-image-url-fetch-line-1'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'x', type: 'error' })));
    expect(updateLineMock).not.toHaveBeenCalled();
    // Retry affordance: the disclosure stays open with the URL intact.
    expect(screen.getByTestId('quote-line-image-url-input-line-1')).toHaveValue('https://internal/w.png');
  });

  it('a fetch that succeeds but a failed line PATCH keeps the URL open for retry', async () => {
    // The remote copy lands an imageId, but the follow-up line PATCH fails: the
    // error toast must NOT be contradicted by the panel collapsing as if saved.
    fromUrlMock.mockResolvedValue(okRes({ imageId: 'img-9' }));
    updateLineMock.mockResolvedValue(errRes());
    await renderWithLine();

    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-image-url-toggle-line-1'));
    fireEvent.change(screen.getByTestId('quote-line-image-url-input-line-1'), { target: { value: 'https://cdn.example.com/w.png' } });
    fireEvent.click(screen.getByTestId('quote-line-image-url-fetch-line-1'));

    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { imageId: 'img-9' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // Disclosure stays open with the URL intact so the user can retry the save.
    expect(screen.getByTestId('quote-line-image-url-input-line-1')).toHaveValue('https://cdn.example.com/w.png');
  });

  it('Cancel closes the disclosure and clears the draft', async () => {
    await renderWithLine();
    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-image-url-toggle-line-1'));
    fireEvent.change(screen.getByTestId('quote-line-image-url-input-line-1'), { target: { value: 'https://x/y.png' } });
    fireEvent.click(screen.getByTestId('quote-line-image-url-cancel-line-1'));
    expect(screen.queryByTestId('quote-line-image-url-input-line-1')).not.toBeInTheDocument();
    // Reopening shows an empty field, not the abandoned draft.
    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-image-url-toggle-line-1'));
    expect(screen.getByTestId('quote-line-image-url-input-line-1')).toHaveValue('');
  });
});
