import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { reorderLines } from '../../../lib/api/quotes';

// Task 4 of the quote-editor UX pass: long-document navigation & structure —
// the rail's "Contents" outline, collapsible pricing blocks, and row drag
// handles that commit through the SAME reorder path as the ⋯ menu.
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
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
  catalogItemImagePath: vi.fn().mockReturnValue('/catalog/x/image'),
}));

const okResponse = () =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: { ok: true } }) } as unknown as Response);

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  removeLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const mkTable = (id: string, sortOrder: number, label?: string): QuoteDetailData['blocks'][number] => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: label ? { label } : {}, sortOrder, createdAt: '2026-06-01T00:00:00Z',
});
const mkHeading = (id: string, sortOrder: number, text: string): QuoteDetailData['blocks'][number] => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType: 'heading',
  content: { text, level: 2 }, sortOrder, createdAt: '2026-06-01T00:00:00Z',
});

const mkLine = (
  id: string, blockId: string, sortOrder: number, overrides: Partial<QuoteDetailData['lines'][number]> = {},
): QuoteDetailData['lines'][number] => ({
  id, quoteId: 'q-1', blockId, orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: `Line ${id}`, quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder,
  createdAt: '2026-06-01T00:00:00Z', ...overrides,
});

const quote: QuoteDetailData['quote'] = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '150.00', taxRate: null,
  taxTotal: '0.00', total: '150.00', oneTimeTotal: '150.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
  termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
};

// Three blocks (pricing / heading / unlabeled pricing) for outline + collapse.
const threeBlocks: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services'), mkHeading('blk-2', 1, 'Summary'), mkTable('blk-3', 2)],
  lines: [mkLine('l-1', 'blk-1', 0), mkLine('l-2', 'blk-1', 1), mkLine('l-3', 'blk-3', 2)],
};

const onePanel: QuoteDetailData = {
  quote,
  blocks: [mkTable('blk-1', 0, 'Services')],
  lines: [mkLine('l-1', 'blk-1', 0)],
};

const reorderLinesMock = vi.mocked(reorderLines);
const dt = () => ({ setData: vi.fn(), effectAllowed: '' });

describe('QuoteEditor — rail Contents outline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('lists every block in document order, with authored labels and typed fallbacks', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const outline = screen.getByTestId('quote-outline');
    expect(outline.tagName).toBe('NAV');
    expect(outline).toHaveAttribute('aria-label', 'Quote contents');
    const items = within(outline).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual(['Services', 'Summary', 'Pricing table 2']);
  });

  it('clicking an entry scrolls the block into view and moves focus to its container', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-outline-item-blk-2'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('quote-block-container-blk-2'));
  });

  it('does not render with a single block', async () => {
    render(<QuoteEditor detail={onePanel} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-outline')).not.toBeInTheDocument();
  });
});

describe('QuoteEditor — collapsible pricing blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('collapsing hides the lines (inert body) and shows label + line count + subtotal', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const toggle = screen.getByTestId('quote-block-collapse-blk-1');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('quote-block-body-blk-1')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.queryByTestId('quote-block-collapsed-summary-blk-1')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const body = screen.getByTestId('quote-block-body-blk-1');
    expect(body).toHaveAttribute('aria-hidden', 'true');
    // Content stays MOUNTED (state survives) but is out of the a11y tree.
    expect(within(body).getByTestId('quote-line-qty-l-1')).toBeInTheDocument();
    // Compact summary: label + line count + block subtotal (2 × $50.00).
    const summary = screen.getByTestId('quote-block-collapsed-summary-blk-1');
    expect(summary).toHaveTextContent('Services');
    expect(summary).toHaveTextContent('2 lines · $100.00');

    // Expanding restores the body.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('quote-block-body-blk-1')).toHaveAttribute('aria-hidden', 'false');
  });

  it('a block with dirty (uncommitted) line edits refuses to collapse', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // Dirty a line: the draft reaches the parent, which pins the block open.
    fireEvent.change(screen.getByTestId('quote-line-qty-l-1'), { target: { value: '3' } });

    const toggle = screen.getByTestId('quote-block-collapse-blk-1');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('quote-block-body-blk-1')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.queryByTestId('quote-block-collapsed-summary-blk-1')).not.toBeInTheDocument();

    // A sibling block without dirty edits still collapses.
    fireEvent.click(screen.getByTestId('quote-block-collapse-blk-3'));
    expect(screen.getByTestId('quote-block-body-blk-3')).toHaveAttribute('aria-hidden', 'true');
  });

  it('a missing-cost reveal expands a collapsed block, then the line band, then focuses the cost input', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-editor-toggle-internal'));

    // Collapse the block that holds the first offender (l-1 has no cost).
    fireEvent.click(screen.getByTestId('quote-block-collapse-blk-1'));
    expect(screen.getByTestId('quote-block-body-blk-1')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByTestId('quote-margin-missing-cost'));

    // Block expands first, then the internal band, then focus lands.
    await waitFor(() => expect(screen.getByTestId('quote-block-body-blk-1')).toHaveAttribute('aria-hidden', 'false'));
    await waitFor(() => expect(screen.getByTestId('quote-line-internal-toggle-l-1')).toHaveAttribute('aria-expanded', 'true'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('quote-line-cost-l-1')));
  });
});

describe('QuoteEditor — line drag-to-reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.permissions = [{ resource: '*', action: '*' }];
    reorderLinesMock.mockResolvedValue(okResponse());
  });

  it('drop gaps only exist mid-drag; a drop commits the same reorderLines PATCH as the menu move', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // No gaps at rest.
    expect(screen.queryByTestId('quote-line-drop-gap-blk-1-0')).not.toBeInTheDocument();

    const handle = screen.getByTestId('quote-line-drag-l-1');
    fireEvent.dragStart(handle, { dataTransfer: dt() });

    // Gaps appear: one above each row + one after the last (indexes 0..2).
    const gap = screen.getByTestId('quote-line-drop-gap-blk-1-2');
    fireEvent.dragOver(gap, { dataTransfer: dt() });
    fireEvent.drop(gap, { dataTransfer: dt() });

    // Same persistence path as the ⋯ menu's Move up/down: full id list to
    // reorderLines (debounced), l-1 dropped after l-2.
    await waitFor(() => expect(reorderLinesMock).toHaveBeenCalledWith('q-1', 'blk-1', { lineIds: ['l-2', 'l-1'] }));
    // Optimistic: the drag handle's row now renders after l-2 in the table.
    const table = screen.getByTestId('quote-block-lines-blk-1');
    const rows = within(table).getAllByTestId(/^quote-line-(l-1|l-2)$/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['quote-line-l-2', 'quote-line-l-1']);
    // Gaps are gone after the drop.
    expect(screen.queryByTestId('quote-line-drop-gap-blk-1-0')).not.toBeInTheDocument();
  });

  it('a drop back into the same slot sends nothing', async () => {
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.dragStart(screen.getByTestId('quote-line-drag-l-1'), { dataTransfer: dt() });
    const gap = screen.getByTestId('quote-line-drop-gap-blk-1-0');
    fireEvent.dragOver(gap, { dataTransfer: dt() });
    fireEvent.drop(gap, { dataTransfer: dt() });

    await new Promise((r) => setTimeout(r, 400)); // outlive the 250ms debounce
    expect(reorderLinesMock).not.toHaveBeenCalled();
  });

  it('read-only rows render no drag handle', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    render(<QuoteEditor detail={threeBlocks} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // Rows render (read-only variant) with no drag affordance.
    expect(screen.getByTestId('quote-line-l-1')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-line-drag-l-1')).not.toBeInTheDocument();
  });
});
