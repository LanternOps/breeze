// Task D — bulk edit: multi-select lines → set markup / cost / taxable across
// the selection, batched through the SAME per-line editLine commit path the
// inline inputs use (no bulk endpoint). Covers selection mechanics (row
// checkbox, per-block select-all + indeterminate, collapse survival, readonly
// exclusion), the bar's actions, honest partial-failure reporting, and
// Escape/Clear semantics.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { updateLine } from '../../../lib/api/quotes';

// Mutable permission set so the readonly test can drop quotes:write without a
// second mock module (the factory below closes over this hoisted object).
const authState = vi.hoisted(() => ({
  permissions: [{ resource: '*', action: '*' }] as { resource: string; action: string }[],
}));

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: authState.permissions } }),
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
  catalogItemImagePath: vi.fn().mockReturnValue('/catalog/c-1/image'),
}));

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
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
  content: { label: 'Hardware' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const baseLine: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: '20.00', sku: null, partNumber: null,
  name: 'Firewall', description: null, quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

// line-2 deliberately has NO cost (markup has no base there); line-3 has one.
const lines: QuoteDetailData['lines'] = [
  baseLine,
  { ...baseLine, id: 'line-2', name: 'Onboarding labor', unitCost: null, sortOrder: 1 },
  { ...baseLine, id: 'line-3', name: 'Access point', unitCost: '10.00', unitPrice: '25.00', lineTotal: '25.00', sortOrder: 2 },
];

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '125.00', taxRate: null,
    taxTotal: '0.00', total: '125.00', oneTimeTotal: '125.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [block],
  lines,
};

const updateLineMock = vi.mocked(updateLine);
const okResponse = () =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response);

async function renderEditor(d: QuoteDetailData = detail) {
  render(<QuoteEditor detail={d} onChanged={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
}

describe('QuoteEditor — bulk edit (Task D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.permissions = [{ resource: '*', action: '*' }];
    updateLineMock.mockResolvedValue(okResponse());
  });

  it('selecting a line shows the bulk bar with the count; more selections update it', async () => {
    await renderEditor();
    expect(screen.queryByTestId('quote-bulk-bar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    expect(screen.getByTestId('quote-bulk-bar')).toBeInTheDocument();
    expect(screen.getByTestId('quote-bulk-count')).toHaveTextContent('1 line selected');

    fireEvent.click(screen.getByTestId('quote-line-select-line-3'));
    expect(screen.getByTestId('quote-bulk-count')).toHaveTextContent('2 lines selected');
    expect((screen.getByTestId('quote-line-select-line-1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('quote-line-select-line-2') as HTMLInputElement).checked).toBe(false);
  });

  it('the block header select-all selects/deselects every line and goes indeterminate on a subset', async () => {
    await renderEditor();
    const selectAll = screen.getByTestId('quote-block-select-all-blk-1') as HTMLInputElement;

    // Subset → indeterminate, not checked.
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    await waitFor(() => expect(selectAll.indeterminate).toBe(true));
    expect(selectAll.checked).toBe(false);

    // Select-all → every row checked, indeterminate cleared.
    fireEvent.click(selectAll);
    expect(screen.getByTestId('quote-bulk-count')).toHaveTextContent('3 lines selected');
    for (const id of ['line-1', 'line-2', 'line-3']) {
      expect((screen.getByTestId(`quote-line-select-${id}`) as HTMLInputElement).checked).toBe(true);
    }
    await waitFor(() => expect(selectAll.indeterminate).toBe(false));
    expect(selectAll.checked).toBe(true);

    // Unchecking select-all empties the selection and dismisses the bar.
    fireEvent.click(selectAll);
    expect(screen.queryByTestId('quote-bulk-bar')).not.toBeInTheDocument();
  });

  it('bulk Set markup rewrites each selected line’s price from its OWN cost via the per-line commit path', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-select-line-3'));

    fireEvent.click(screen.getByTestId('quote-bulk-set-markup'));
    fireEvent.change(screen.getByTestId('quote-bulk-value'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('quote-bulk-apply'));

    // cost 20 → price 30; cost 10 → price 15 (price = cost·(1+m)), one PATCH per line.
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitPrice: 30 }));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-3', { unitPrice: 15 }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Updated 2 lines.' })),
    );
    // Selection is deliberately kept after an apply (a follow-up bulk action on
    // the same set is the common flow).
    expect(screen.getByTestId('quote-bulk-count')).toHaveTextContent('2 lines selected');
  });

  it('bulk Set markup skips selected lines with no cost and reports the skipped count honestly', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-block-select-all-blk-1'));

    fireEvent.click(screen.getByTestId('quote-bulk-set-markup'));
    // The hint says up front that markup needs a cost base.
    expect(screen.getByTestId('quote-bulk-markup-hint')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('quote-bulk-value'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('quote-bulk-apply'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: 'Skipped 1 line with no cost.' })),
    );
    expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitPrice: 30 });
    expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-3', { unitPrice: 15 });
    expect(updateLineMock).not.toHaveBeenCalledWith('q-1', 'line-2', expect.anything());
  });

  // Task B1: an explicit cost of 0 ("no cost", e.g. labor/service) is a real,
  // known cost — NOT the same as line-2's null/unknown cost — but markup still
  // has no usable base at cost $0 (price = 0·(1+m) = 0 regardless of m%), so
  // bulk markup skips it too and folds it into the same honest skip count.
  it('bulk Set markup also skips lines with an explicit cost of 0, counted with the unknown-cost skips', async () => {
    const withNoCostLine: QuoteDetailData = {
      ...detail,
      lines: [
        ...lines,
        { ...baseLine, id: 'line-4', name: 'Included setup', unitCost: '0.00', unitPrice: '10.00', lineTotal: '10.00', sortOrder: 3 },
      ],
    };
    await renderEditor(withNoCostLine);
    fireEvent.click(screen.getByTestId('quote-block-select-all-blk-1'));

    fireEvent.click(screen.getByTestId('quote-bulk-set-markup'));
    fireEvent.change(screen.getByTestId('quote-bulk-value'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('quote-bulk-apply'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: 'Skipped 2 lines with no cost.' })),
    );
    expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitPrice: 30 });
    expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-3', { unitPrice: 15 });
    expect(updateLineMock).not.toHaveBeenCalledWith('q-1', 'line-2', expect.anything());
    expect(updateLineMock).not.toHaveBeenCalledWith('q-1', 'line-4', expect.anything());
  });

  it('bulk Set cost PATCHes unitCost on every selected line', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-select-line-2'));

    fireEvent.click(screen.getByTestId('quote-bulk-set-cost'));
    fireEvent.change(screen.getByTestId('quote-bulk-value'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByTestId('quote-bulk-apply'));

    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitCost: 12.5 }));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-2', { unitCost: 12.5 }));
  });

  it('an empty bulk value shows an inline error and PATCHes nothing', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    fireEvent.click(screen.getByTestId('quote-bulk-set-cost'));
    fireEvent.click(screen.getByTestId('quote-bulk-apply'));

    expect(screen.getByTestId('quote-bulk-value-error')).toBeInTheDocument();
    expect(screen.getByTestId('quote-bulk-value')).toHaveAttribute('aria-invalid', 'true');
    expect(updateLineMock).not.toHaveBeenCalled();
  });

  it('bulk Taxable on/off PATCHes taxable across the selection', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-select-line-2'));

    fireEvent.click(screen.getByTestId('quote-bulk-taxable-on'));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { taxable: true }));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-2', { taxable: true }));

    updateLineMock.mockClear();
    fireEvent.click(screen.getByTestId('quote-bulk-taxable-off'));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { taxable: false }));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-2', { taxable: false }));
  });

  it('a partial failure keeps applying to the rest and reports the failed count in one aggregate toast', async () => {
    updateLineMock.mockImplementation((_qid: string, lineId: string) =>
      lineId === 'line-1'
        ? Promise.resolve({ ok: false, status: 500, statusText: 'ERR', json: vi.fn().mockResolvedValue({}) } as unknown as Response)
        : Promise.resolve(okResponse()));
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    fireEvent.click(screen.getByTestId('quote-line-select-line-3'));

    fireEvent.click(screen.getByTestId('quote-bulk-taxable-on'));

    // The failing line does not abort the rest…
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-3', { taxable: true }));
    // …and the aggregate outcome states the failure count (no silent partial success).
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: '1 of 2 lines failed to update.' })),
    );
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^Updated/) }));
  });

  it('Escape on the bar clears the selection (closing an open value editor first); Clear selection clears too', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));

    // With a value editor open, the first Escape only closes the editor.
    fireEvent.click(screen.getByTestId('quote-bulk-set-markup'));
    expect(screen.getByTestId('quote-bulk-value')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('quote-bulk-bar'), { key: 'Escape' });
    expect(screen.queryByTestId('quote-bulk-value')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-bulk-bar')).toBeInTheDocument();

    // The next Escape empties the selection.
    fireEvent.keyDown(screen.getByTestId('quote-bulk-bar'), { key: 'Escape' });
    expect(screen.queryByTestId('quote-bulk-bar')).not.toBeInTheDocument();
    expect((screen.getByTestId('quote-line-select-line-1') as HTMLInputElement).checked).toBe(false);

    // Clear selection button does the same.
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    fireEvent.click(screen.getByTestId('quote-bulk-clear'));
    expect(screen.queryByTestId('quote-bulk-bar')).not.toBeInTheDocument();
  });

  it('selection survives collapsing and re-expanding the pricing block', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('quote-line-select-line-1'));
    expect(screen.getByTestId('quote-bulk-count')).toHaveTextContent('1 line selected');

    fireEvent.click(screen.getByTestId('quote-block-collapse-blk-1')); // collapse
    expect(screen.getByTestId('quote-bulk-count')).toHaveTextContent('1 line selected');

    fireEvent.click(screen.getByTestId('quote-block-collapse-blk-1')); // expand
    expect((screen.getByTestId('quote-line-select-line-1') as HTMLInputElement).checked).toBe(true);
  });

  it('read-only users get no selection checkboxes (rows or block header)', async () => {
    authState.permissions = [{ resource: 'quotes', action: 'read' }];
    await renderEditor();

    expect(screen.queryByTestId('quote-line-select-line-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-select-all-blk-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-bulk-bar')).not.toBeInTheDocument();
  });

  it('checkbox and select-all carry aria-labels naming the line / the table', async () => {
    await renderEditor();
    expect(screen.getByTestId('quote-line-select-line-1')).toHaveAttribute('aria-label', 'Select Firewall');
    expect(screen.getByTestId('quote-block-select-all-blk-1')).toHaveAttribute('aria-label', 'Select all lines in Hardware');
  });
});
