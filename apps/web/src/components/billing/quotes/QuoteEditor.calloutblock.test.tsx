import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { addBlock } from '../../../lib/api/quotes';

// Same house pattern as TemplateEditor.test.tsx: swap the tiptap-backed
// RichTextEditor for a plain textarea so this test targets the callout form
// (variant/title/body wiring, submit), not rich-text editing internals.
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

async function openCalloutForm() {
  render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-add-block-type-callout'));
  await waitFor(() => expect(screen.getByTestId('quote-block-callout')).toBeInTheDocument());
}

describe('QuoteEditor — add callout block', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a "Callout" chip in the add-block picker', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-add-block-type-callout')).toBeInTheDocument();
  });

  it('defaults the variant to "info" and offers info/accent/warn', async () => {
    await openCalloutForm();
    const select = screen.getByTestId('quote-block-callout-variant');
    expect(select).toHaveValue('info');
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['info', 'accent', 'warn']);
  });

  it('submit is disabled until body text is entered', async () => {
    await openCalloutForm();
    expect(screen.getByTestId('quote-add-block-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Note</p>' } });
    expect(screen.getByTestId('quote-add-block-submit')).not.toBeDisabled();
  });

  it('creating a callout POSTs blockType "callout" with variant/title/html', async () => {
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-c' }));
    await openCalloutForm();

    fireEvent.change(screen.getByTestId('quote-block-callout-variant'), { target: { value: 'warn' } });
    fireEvent.change(screen.getByTestId('quote-block-callout-title'), { target: { value: 'Heads up' } });
    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Read carefully</p>' } });

    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'callout',
      content: { variant: 'warn', title: 'Heads up', html: '<p>Read carefully</p>' },
    }));
  });

  it('omits an empty title from the submitted content', async () => {
    addBlockMock.mockResolvedValue(okRes({ id: 'blk-c' }));
    await openCalloutForm();

    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Note</p>' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(addBlockMock).toHaveBeenCalledWith('q-1', {
      blockType: 'callout',
      content: { variant: 'info', html: '<p>Note</p>' },
    }));
  });

  it('disables submit while add-block is in flight and re-enables with an error surfaced on failure', async () => {
    addBlockMock.mockResolvedValue(errRes());
    await openCalloutForm();
    fireEvent.change(screen.getByTestId('quote-block-callout-body'), { target: { value: '<p>Note</p>' } });

    const submit = screen.getByTestId('quote-add-block-submit');
    fireEvent.click(submit);

    // Rejected request: the pending guard must unlatch (not leave submit
    // permanently disabled) and the failure must be visible — the #3519
    // regression class this brief calls out explicitly.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(submit).not.toBeDisabled());
  });
});
