import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// #2151 — the rail's live-totals status node announced ~800ms after load on a
// quote nobody had touched.
//
// The old guard skipped only the FIRST run of the debounce effect, whose dep was
// the announcement SENTENCE. That is not the same thing as "the totals changed":
// any later render that produces different sentence TEXT while the figures sit
// still fires the effect a second time, past the guard, and announces totals the
// user never touched. i18n resources arriving after the first paint do exactly
// that — the sentence goes from raw key to real copy on an untouched quote. The
// fix keys the effect on the figures themselves.
//
// The `useTranslation` mock below is what makes these tests non-vacuous: it
// reproduces that settle (raw keys until `i18n.ready` is flipped, real copy
// after). Without it nothing changes the sentence text and the buggy version
// passes too — verified by reverting the fix and watching these go red.
const i18n = vi.hoisted(() => ({ ready: true }));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: ((...args: Parameters<typeof actual.useTranslation>) => {
      const real = actual.useTranslation(...args);
      const t = ((key: string, ...rest: unknown[]) =>
        (i18n.ready
          ? (real.t as unknown as (...a: unknown[]) => unknown)(key, ...rest)
          : key)) as unknown as typeof real.t;
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object), real, { t });
    }) as typeof actual.useTranslation,
  };
});

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
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
}));
vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  uploadQuoteImage: vi.fn(),
  addQuoteImageFromUrl: vi.fn(),
  updateQuote: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const baseLine: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: 'Firewall install', description: 'Setup', quantity: '1.00',
  unitPrice: '500.00', taxable: true, customerVisible: true, lineTotal: '500.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const baseQuote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '500.00', taxRate: '0',
  taxTotal: '0.00', total: '500.00', oneTimeTotal: '500.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '500.00', billToName: null, introNotes: null,
  terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const detail = (): QuoteDetailData => ({ quote: baseQuote, blocks: [block], lines: [baseLine] });

describe('QuoteEditor — live-totals SR announcement (#2151)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.ready = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    i18n.ready = true;
    vi.useRealTimers();
  });

  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('stays silent on a freshly-loaded quote nobody has edited', async () => {
    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    await advance(2000);

    expect(screen.getByTestId('quote-totals-sr')).toBeEmptyDOMElement();
  });

  it('stays silent when late-arriving translations change the sentence but not the figures', async () => {
    i18n.ready = false;
    const { rerender } = render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    // Resources land: the sentence goes from raw key to real copy on a quote
    // nobody has touched. This is the render that defeated the old
    // skip-the-first-run guard and announced the untouched totals.
    i18n.ready = true;
    rerender(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await advance(2000);

    expect(screen.getByTestId('quote-totals-sr')).toBeEmptyDOMElement();
  });

  it('announces the settled totals once the figures actually change', async () => {
    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    fireEvent.change(screen.getByTestId('quote-line-qty-line-1'), { target: { value: '3' } });
    await advance(2000);

    expect(screen.getByTestId('quote-totals-sr')).toHaveTextContent('$1,500.00');
  });

  it('holds the announcement until the settle window elapses (still debounced)', async () => {
    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    fireEvent.change(screen.getByTestId('quote-line-qty-line-1'), { target: { value: '3' } });
    await advance(400);

    expect(screen.getByTestId('quote-totals-sr')).toBeEmptyDOMElement();
  });

  it('announces only the final figure when edits arrive inside one settle window', async () => {
    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await screen.findByTestId('quote-editor');

    const qty = screen.getByTestId('quote-line-qty-line-1');
    fireEvent.change(qty, { target: { value: '2' } });
    await advance(300);
    fireEvent.change(qty, { target: { value: '4' } });
    await advance(2000);

    const sr = screen.getByTestId('quote-totals-sr');
    expect(sr).toHaveTextContent('$2,000.00');
    expect(sr).not.toHaveTextContent('$1,000.00');
  });
});
