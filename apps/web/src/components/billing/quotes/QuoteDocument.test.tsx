import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTE_DTO_FIXTURES, QUOTE_FIXTURE_IDS, type QuoteFixtureName } from '@breeze/shared/documents';

import QuoteDocumentPreview from './QuoteDocument';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const detail = () => ({ quote: { id: 'q-1', quoteNumber: 'Q-1', status: 'sent' }, blocks: [], lines: [] } as unknown as QuoteDetailData);
const ok = (name: QuoteFixtureName, patch?: (d: (typeof QUOTE_DTO_FIXTURES)[QuoteFixtureName]) => unknown) =>
  ({ ok: true, status: 200, json: async () => ({ data: patch ? patch(QUOTE_DTO_FIXTURES[name]) : QUOTE_DTO_FIXTURES[name] }) });

// Braces: a returned mock would be run by vitest as a cleanup hook.
beforeEach(() => { fetchWithAuth.mockReset(); });

describe('QuoteDocumentPreview', () => {
  it('renders the CUSTOMER document from GET /quotes/:id/customer-view, with a Download PDF action', async () => {
    fetchWithAuth.mockResolvedValue(ok('issued'));
    render(<QuoteDocumentPreview detail={detail()} />);
    expect(screen.getByTestId('quote-preview-loading')).toBeInTheDocument();
    await screen.findByTestId('document-root');
    expect(fetchWithAuth).toHaveBeenCalledWith('/quotes/q-1/customer-view');
    expect(screen.getByTestId('quote-preview-download-pdf')).toBeInTheDocument();
    expect(screen.getByTestId('document-root')).toHaveTextContent('Q-0042');
    expect(screen.getByTestId('document-root')).toHaveTextContent('Viewed');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('refetches when the workspace hands a new detail object (reload), and when the tab remounts', async () => {
    fetchWithAuth.mockResolvedValue(ok('issued'));
    const views = () => fetchWithAuth.mock.calls.filter(([p]) => p === '/quotes/q-1/customer-view').length;
    const d = detail();
    const { rerender, unmount } = render(<QuoteDocumentPreview detail={d} />);
    await screen.findByTestId('document-root');
    expect(views()).toBe(1);
    rerender(<QuoteDocumentPreview detail={d} />);
    expect(views()).toBe(1); // same object: no refetch
    rerender(<QuoteDocumentPreview detail={detail()} />);
    await waitFor(() => expect(views()).toBe(2));
    unmount();
    render(<QuoteDocumentPreview detail={detail()} />);
    await waitFor(() => expect(views()).toBe(3));
  });

  it('shows an error with a working Retry when the customer view fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<QuoteDocumentPreview detail={detail()} />);
    await screen.findByTestId('quote-preview-error');
    fetchWithAuth.mockResolvedValueOnce(ok('issued'));
    fireEvent.click(screen.getByTestId('quote-preview-retry'));
    await screen.findByTestId('document-root');
    spy.mockRestore();
  });

  it('treats a malformed body as an error rather than throwing in render', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { quote: {} } }) });
    render(<QuoteDocumentPreview detail={detail()} />);
    await screen.findByTestId('quote-preview-error');
    spy.mockRestore();
  });

  it('discards an older response that finishes after a newer request', async () => {
    let releaseOld!: (v: unknown) => void;
    fetchWithAuth.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
    const { rerender } = render(<QuoteDocumentPreview detail={detail()} />);
    fetchWithAuth.mockResolvedValueOnce(ok('cover'));
    rerender(<QuoteDocumentPreview detail={detail()} />);
    await screen.findByTestId('document-cover');
    await act(async () => { releaseOld(ok('issued')); });
    expect(screen.getByTestId('document-cover')).toBeInTheDocument();
  });

  it('marks where the customer signs, inert, while the quote can still be signed', async () => {
    fetchWithAuth.mockResolvedValue(ok('issued'));
    render(<QuoteDocumentPreview detail={detail()} />);
    const slot = await screen.findByTestId('quote-preview-signature');
    expect(slot).toHaveTextContent('Your customer signs here');
    expect(slot.querySelector('button, input')).toBeNull();
  });

  it('shows no signature placeholder on an accepted quote', async () => {
    fetchWithAuth.mockResolvedValue(ok('issued', (d) => ({ ...d, quote: { ...d.quote, status: 'accepted', displayStatus: 'accepted' } })));
    render(<QuoteDocumentPreview detail={detail()} />);
    await screen.findByTestId('document-root');
    expect(screen.queryByTestId('quote-preview-signature')).toBeNull();
  });

  it('a draft previews with the draft number and the cover when enabled', async () => {
    fetchWithAuth.mockResolvedValue(ok('draft'));
    render(<QuoteDocumentPreview detail={detail()} />);
    expect((await screen.findByTestId('document-root')).querySelector('h1')).toHaveTextContent('Proposal');
    expect(screen.getByTestId('quote-preview-signature')).toBeInTheDocument();
  });

  it('delivers the partner accent through CSSOM on the wrapper, never a style attribute on the paper', async () => {
    fetchWithAuth.mockResolvedValue(ok('issued'));
    render(<QuoteDocumentPreview detail={detail()} />);
    const wrapper = await screen.findByTestId('quote-preview-paper');
    await waitFor(() => expect(wrapper.style.getPropertyValue('--doc-accent')).toBe('#1d4ed8'));
    expect(screen.getByTestId('document-root').getAttribute('style')).toBeNull();
  });
});

describe('web host components for a quote (authenticated routes)', () => {
  it('loads a line thumbnail, the cover and a block image through the authed fetch, from the payload routes', async () => {
    const create = vi.fn(() => 'blob:img');
    Object.defineProperty(window.URL, 'createObjectURL', { value: create, configurable: true });
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (path.endsWith('/customer-view')) return ok('cover');
      return { ok: true, status: 200, blob: async () => new Blob(['x']) };
    });
    render(<QuoteDocumentPreview detail={detail()} />);
    await screen.findByTestId('document-cover');
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/api/v1/quotes/${QUOTE_FIXTURE_IDS.quote}/images/${QUOTE_FIXTURE_IDS.coverImage}`));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/quotes/public/tok/line-image/${id(101)}`));
  });

  it('an uploaded agreement is fetched only once opened, then shown in an iframe with a download link', async () => {
    Object.defineProperty(window.URL, 'createObjectURL', { value: vi.fn(() => 'blob:pdf'), configurable: true });
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (path.endsWith('/customer-view')) return ok('agreements');
      return { ok: true, status: 200, blob: async () => new Blob(['pdf']) };
    });
    render(<QuoteDocumentPreview detail={detail()} />);
    await screen.findByTestId('document-agreements');
    const row = document.getElementById(`agreement-${id(40)}`) as HTMLDetailsElement;
    const filePath = `/quotes/public/tok/contract-file/${id(40)}`;
    expect(fetchWithAuth).not.toHaveBeenCalledWith(filePath);
    row.open = true;
    fireEvent(row, new Event('toggle'));
    await waitFor(() => expect(row.querySelector('iframe')?.getAttribute('src')).toBe('blob:pdf'));
    expect(fetchWithAuth).toHaveBeenCalledWith(filePath);
    expect(row.querySelector('iframe')?.getAttribute('title')).toBe('MSA (PDF)');
    expect(screen.getByTestId('quote-contract-download').textContent).toBe('Download agreement');
  });

  it('a failed agreement fetch shows the unavailable text instead of a frame', async () => {
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (path.endsWith('/customer-view')) return ok('agreements');
      return { ok: false, status: 404 };
    });
    render(<QuoteDocumentPreview detail={detail()} />);
    await screen.findByTestId('document-agreements');
    const row = document.getElementById(`agreement-${id(40)}`) as HTMLDetailsElement;
    row.open = true;
    fireEvent(row, new Event('toggle'));
    await waitFor(() => expect(row.textContent).toContain('Agreement file unavailable'));
    expect(row.querySelector('iframe')).toBeNull();
  });
});
