import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { updateLine } from '../../../lib/api/quotes';

// Task 3 of the quote-editor UX pass: the rail's "missing cost" notice becomes
// an actionable button that reveals the first offending line; the missing-cost
// figure is flagged even while a line's internal band is collapsed; and a dirty
// field exposes an sr-only "Unsaved" cue alongside the sighted amber ring.
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
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
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Monthly services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const baseLine: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: '20.00', sku: null, partNumber: null,
  name: null, description: 'Managed support', quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const baseQuote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '50.00', taxRate: null,
  taxTotal: '0.00', total: '50.00', oneTimeTotal: '50.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

const detailWith = (lines: QuoteDetailData['lines']): QuoteDetailData => ({
  quote: baseQuote, blocks: [block], lines,
});

describe('QuoteEditor — missing-cost warning treatment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
  });

  it('flags the collapsed summary\'s Cost figure when the line has no cost', async () => {
    const detail = detailWith([{ ...baseLine, unitCost: null }]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    const missing = screen.getByTestId('quote-line-cost-missing-line-1');
    expect(missing).toHaveTextContent('Cost —');
    expect(missing).toHaveAttribute('aria-label', 'Cost not entered — this line is excluded from the profit estimate.');
  });

  it('does not flag a line that has a cost', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    expect(screen.queryByTestId('quote-line-cost-missing-line-1')).not.toBeInTheDocument();
  });
});

describe('QuoteEditor — actionable missing-cost reveal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
    // jsdom doesn't implement scrollIntoView; stub it so the reveal effect's
    // call is observable and doesn't throw.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('is a real button (not a static <p>) that reveals the first offending line', async () => {
    const detail = detailWith([
      { ...baseLine, id: 'line-1', unitCost: '20.00' }, // has a cost — not the target
      { ...baseLine, id: 'line-2', unitCost: null }, // first offender
      { ...baseLine, id: 'line-3', unitCost: null },
    ]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    const notice = screen.getByTestId('quote-margin-missing-cost');
    expect(notice.tagName).toBe('BUTTON');
    // Both offending bands start collapsed.
    expect(screen.getByTestId('quote-line-internal-toggle-line-2')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(notice);

    // Expands line-2 (the FIRST offender, not line-3) and scrolls it into view.
    await waitFor(() => expect(screen.getByTestId('quote-line-internal-toggle-line-2')).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByTestId('quote-line-internal-toggle-line-3')).toHaveAttribute('aria-expanded', 'false');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    // Focuses the cost input once the band is reachable (not `inert`).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('quote-line-cost-line-2')));
  });

  it('re-clicking after scrolling away re-reveals the same line', async () => {
    const detail = detailWith([{ ...baseLine, id: 'line-1', unitCost: null }]);
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    const notice = screen.getByTestId('quote-margin-missing-cost');
    fireEvent.click(notice);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('quote-line-cost-line-1')));

    // Manually blur + collapse, then click again — it re-expands and re-focuses.
    fireEvent.click(screen.getByTestId('quote-line-internal-toggle-line-1'));
    expect(screen.getByTestId('quote-line-internal-toggle-line-1')).toHaveAttribute('aria-expanded', 'false');
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.click(notice);
    await waitFor(() => expect(screen.getByTestId('quote-line-internal-toggle-line-1')).toHaveAttribute('aria-expanded', 'true'));
  });
});

describe('QuoteEditor — sr-only unsaved cue for dirty line fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
  });

  it('a dirty qty field gets an sr-only "Unsaved" description with no visible badge', async () => {
    render(<QuoteEditor detail={detailWith([baseLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const qty = screen.getByTestId('quote-line-qty-line-1');
    expect(qty).not.toHaveAttribute('aria-describedby');

    fireEvent.change(qty, { target: { value: '3' } });
    const describedBy = qty.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain('quote-line-qty-unsaved-line-1');

    const hint = document.getElementById('quote-line-qty-unsaved-line-1');
    expect(hint).toHaveTextContent('Unsaved');
    expect(hint).toHaveClass('sr-only');

    // Committing clears the dirty flag; jsdom's updateLine mock resolves with
    // no persisted change here, so this only asserts the hint follows dirty —
    // re-typing back to the persisted value un-dirties without a save.
    fireEvent.change(qty, { target: { value: '1' } });
    fireEvent.blur(qty);
    expect(updateLine).not.toHaveBeenCalled();
    expect(qty).not.toHaveAttribute('aria-describedby');
  });

  it('a dirty cost field gets its own sr-only unsaved id, distinct from the missing-cost warning', async () => {
    render(<QuoteEditor detail={detailWith([{ ...baseLine, unitCost: null }])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));
    fireEvent.click(screen.getByTestId('quote-line-internal-toggle-line-1'));

    const cost = screen.getByTestId('quote-line-cost-line-1');
    fireEvent.change(cost, { target: { value: '10' } });
    expect(cost.getAttribute('aria-describedby')).toContain('quote-line-cost-unsaved-line-1');
    expect(document.getElementById('quote-line-cost-unsaved-line-1')).toHaveTextContent('Unsaved');
  });
});
