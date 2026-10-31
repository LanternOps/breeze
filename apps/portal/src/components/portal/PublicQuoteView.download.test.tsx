// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PublicQuoteDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';

// #9860: the public proposal link offers Download PDF (GET /quotes/public/:token/pdf),
// like the public invoice page, so a client without a portal account can keep a copy
// of the document they sign.

const DETAIL: PublicQuoteDetail = {
  quote: {
    id: '11111111-1111-4111-8111-111111111111',
    quoteNumber: 'Q-2026-0042',
    title: 'Managed Services',
    status: 'viewed',
    currencyCode: 'USD',
    issueDate: '2026-07-01',
    expiryDate: '2026-08-01',
    subtotal: '100.00',
    taxRate: null,
    taxTotal: '0.00',
    total: '100.00',
    oneTimeTotal: '100.00',
    monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00',
    depositType: 'none',
    depositAmount: null,
    dueOnAcceptanceTotal: '100.00',
    depositDueTotal: null,
    categoryBreakdown: [],
    billToName: 'Acme Co',
    introNotes: null,
    terms: null,
    sellerSnapshot: null,
    coverPage: null,
    termsAndConditions: null,
  },
  blocks: [],
  lines: [],
  branding: { partnerName: 'Lantern IT', logoUrl: null, primaryColor: '#123456' },
};

const TOKEN = 'tok/with space';

let fetchMock: ReturnType<typeof vi.fn>;
let anchorDownloads: string[];

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  anchorDownloads = [];
  Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:proposal') });
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    anchorDownloads.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PublicQuoteView Download PDF', () => {
  it('downloads the proposal PDF from the token route', async () => {
    fetchMock.mockResolvedValue(new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    render(<PublicQuoteView token={TOKEN} initial={DETAIL} />);

    fireEvent.click(screen.getByTestId('public-quote-download'));

    await waitFor(() => expect(anchorDownloads).toEqual(['Q-2026-0042.pdf']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/v1\/quotes\/public\/tok%2Fwith%20space\/pdf$/);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:proposal');
    expect(screen.queryByTestId('public-quote-download-error')).toBeNull();
  });

  it('says so when the download fails instead of saving an error body as a PDF', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Quote not found' }), { status: 404 }));
    render(<PublicQuoteView token={TOKEN} initial={DETAIL} />);

    fireEvent.click(screen.getByTestId('public-quote-download'));

    expect(await screen.findByTestId('public-quote-download-error')).toHaveTextContent('Could not download the proposal PDF.');
    expect(anchorDownloads).toEqual([]);
  });

  it('reports a network failure the same way', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<PublicQuoteView token={TOKEN} initial={DETAIL} />);

    fireEvent.click(screen.getByTestId('public-quote-download'));

    expect(await screen.findByTestId('public-quote-download-error')).toHaveTextContent('Could not download the proposal PDF.');
    expect((screen.getByTestId('public-quote-download') as HTMLButtonElement).disabled).toBe(false);
  });

  it('stays available after the proposal is accepted or declined (the copy they signed)', () => {
    render(<PublicQuoteView token={TOKEN} initial={{ ...DETAIL, quote: { ...DETAIL.quote, status: 'converted' } }} />);
    expect(screen.getByTestId('public-quote-download')).toBeTruthy();
  });

  it('is not offered on a replaced proposal or a dead link', () => {
    render(<PublicQuoteView token={TOKEN} initial={null} superseded={{ partnerName: 'Lantern IT' }} />);
    expect(screen.queryByTestId('public-quote-download')).toBeNull();
    cleanup();
    render(<PublicQuoteView token={TOKEN} initial={null} error="This proposal link is invalid or has expired." />);
    expect(screen.queryByTestId('public-quote-download')).toBeNull();
  });
});
