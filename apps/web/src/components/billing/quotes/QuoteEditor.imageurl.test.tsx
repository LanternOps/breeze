import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { addBlock, addQuoteImageFromUrl } from '../../../lib/api/quotes';

vi.mock('../../../stores/auth', () => ({
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
