import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { updateLine, uploadQuoteImage } from '../../../lib/api/quotes';

// Writer permissions so the inline line editor renders (read-only hides it).
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
  polishTextRequest: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK',
      json: vi.fn().mockResolvedValue({ data: { name: null, description: 'Premium managed support.', changed: true } }) } as unknown as Response,
  ),
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

const line: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: 'Managed support', quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'monthly', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '50.00', taxRate: null,
    taxTotal: '0.00', total: '50.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '50.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [block],
  lines: [line],
};

const updateLineMock = vi.mocked(updateLine);

describe('QuoteEditor — inline line editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateLineMock.mockResolvedValue(
      { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
    );
  });

  it('renders existing lines with editable fields', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect((screen.getByTestId('quote-line-desc-line-1') as HTMLTextAreaElement).value).toBe('Managed support');
    // Quantity shows its bare form ('1', not the stored '1.00') — matching the
    // input's step="1" and the customer-facing rendering.
    expect((screen.getByTestId('quote-line-qty-line-1') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('quote-line-price-line-1') as HTMLInputElement).value).toBe('50.00');
    expect(screen.getByTestId('quote-line-recurrence-line-1')).toBeInTheDocument();
    expect(screen.getByTestId('quote-line-taxable-line-1')).toBeInTheDocument();
    // the description editor is a multi-line textarea
    expect(screen.getByTestId('quote-line-desc-line-1').tagName).toBe('TEXTAREA');
  });

  it('renders per-line tax under the Total: empty when not taxable, the computed amount when taxable', async () => {
    // Non-taxable line + no rate → no tax sub-line.
    const { unmount } = render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-line-tax-line-1')).toBeEmptyDOMElement();
    unmount();

    // Taxable line ($50 line total) at 10% → "+ $5.00 tax" under the Total.
    const taxed: QuoteDetailData = {
      ...detail,
      quote: { ...detail.quote, taxRate: '0.1' },
      lines: [{ ...line, taxable: true }],
    };
    render(<QuoteEditor detail={taxed} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-line-tax-line-1')).toHaveTextContent('+ $5.00 tax');
  });

  it('editing the description and blurring PATCHes the line, then refreshes', async () => {
    const onChanged = vi.fn();
    render(<QuoteEditor detail={detail} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const descEl = screen.getByTestId('quote-line-desc-line-1');
    fireEvent.change(descEl, { target: { value: 'Premium managed support' } });
    fireEvent.blur(descEl);

    await waitFor(() => {
      expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { description: 'Premium managed support' });
    });
    // refresh() is coalesced (trailing), so onChanged fires shortly after the PATCH.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // Per-field line edits confirm via the dirty-ring clearing + SrSaved live
    // region, NOT a toast — toasts are reserved for action-level events (line
    // added/removed). A toast per blur was a storm that double-announced.
    await waitFor(() => expect(screen.getByTestId('quote-line-saved-line-1')).toHaveTextContent('Saved'));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Saved' }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Line updated' }));
  });

  it('applying an inline AI polish persists the change via updateLine', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('polish-btn-quote-line-line-1'));
    await waitFor(() => expect(screen.getByTestId('polish-apply-quote-line-line-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('polish-apply-quote-line-line-1'));

    await waitFor(() => {
      expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { description: 'Premium managed support.' });
    });
  });

  it('changing quantity sends a numeric quantity', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const qtyEl = screen.getByTestId('quote-line-qty-line-1');
    fireEvent.change(qtyEl, { target: { value: '3' } });
    fireEvent.blur(qtyEl);

    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { quantity: 3 }));
  });

  it('toggling taxable PATCHes immediately', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-taxable-line-1'));
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { taxable: true }));
  });

  it('changing recurrence PATCHes immediately', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('quote-line-recurrence-line-1'), { target: { value: 'one_time' } });
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { recurrence: 'one_time' }));
  });

  it('blurring an unchanged field does not PATCH', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.blur(screen.getByTestId('quote-line-desc-line-1'));
    fireEvent.blur(screen.getByTestId('quote-line-qty-line-1'));
    fireEvent.blur(screen.getByTestId('quote-line-price-line-1'));
    expect(updateLineMock).not.toHaveBeenCalled();
  });

  it('the manual-line Description is a multi-line textarea', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // switch the add-line builder to the Manual tab
    fireEvent.click(screen.getByTestId('quote-line-mode-blk-1-manual'));
    const manualDesc = screen.getByTestId('quote-manual-desc-blk-1');
    expect(manualDesc.tagName).toBe('TEXTAREA');
  });

  it('re-adopts a server-normalized value after commit (no stuck-dirty row)', async () => {
    // Enter a sub-cent price the server will round (9.999 → 10.00). Once the user
    // stops editing, the refreshed prop must re-adopt the canonical server value
    // rather than leaving the field/total pinned to the raw entry.
    const { rerender } = render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const priceEl = screen.getByTestId('quote-line-price-line-1') as HTMLInputElement;
    fireEvent.change(priceEl, { target: { value: '9.999' } });
    fireEvent.blur(priceEl);
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { unitPrice: 9.999 }));

    // The parent re-pulls; the server normalized the price to 10.00.
    const normalized: QuoteDetailData = {
      ...detail,
      lines: [{ ...line, unitPrice: '10.00', lineTotal: '10.00' }],
    };
    rerender(<QuoteEditor detail={normalized} onChanged={vi.fn()} />);

    await waitFor(() =>
      expect((screen.getByTestId('quote-line-price-line-1') as HTMLInputElement).value).toBe('10.00'),
    );
    // Row total reflects the authoritative server value, not the raw 9.999 entry.
    expect(screen.getByTestId('quote-line-tax-line-1')).toBeInTheDocument();
  });

  it('recomputes the right-rail totals optimistically while a line qty is mid-edit', async () => {
    // The fixture line is a $50/mo recurring line, so the rail shows $50.00
    // monthly. Bumping qty to 3 must move the rail to $150.00 immediately —
    // before any blur/save/refresh — so the rail no longer lags the row.
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-total-monthly')).toHaveTextContent('$50.00');

    fireEvent.change(screen.getByTestId('quote-line-qty-line-1'), { target: { value: '3' } });
    await waitFor(() => expect(screen.getByTestId('quote-total-monthly')).toHaveTextContent('$150.00'));
    // No PATCH yet — this is pure pre-commit optimism.
    expect(updateLineMock).not.toHaveBeenCalled();
  });

  it('row Total uses the shared cents math and agrees with the rail (sub-cent price)', async () => {
    // 3 × 0.335 = 1.005 — naive float formatting can drift a cent from the
    // server's round-half-up-at-the-cent-boundary. The row Total and the rail
    // (both via the shared computeLineTotal) must land on the same $1.01.
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('quote-line-qty-line-1'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('quote-line-price-line-1'), { target: { value: '0.335' } });

    await waitFor(() => expect(screen.getByTestId('quote-line-total-line-1')).toHaveTextContent('$1.01'));
    // The fixture line is monthly, so the rail's monthly figure mirrors it exactly.
    expect(screen.getByTestId('quote-total-monthly')).toHaveTextContent('$1.01');
  });

  it('renders the tax rate read-only (set at creation, not editable per-quote)', async () => {
    const withRate: QuoteDetailData = {
      ...detail,
      quote: { ...detail.quote, taxRate: '0.0895' },
    };
    render(<QuoteEditor detail={withRate} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const rate = screen.getByTestId('quote-tax-rate');
    expect(rate.tagName).not.toBe('INPUT');
    expect(rate).toHaveTextContent('8.95%');
  });

  it('rejects a fractional quantity with an inline error, keeps the input, and PATCHes nothing', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const qtyEl = screen.getByTestId('quote-line-qty-line-1') as HTMLInputElement;
    fireEvent.change(qtyEl, { target: { value: '2.5' } });
    fireEvent.blur(qtyEl);

    // The error renders inline under the row (not a bottom-corner toast), the
    // input keeps the user's entry to correct, and nothing is PATCHed.
    await waitFor(() =>
      expect(screen.getByTestId('quote-line-qty-error-line-1')).toHaveTextContent('whole-number quantity'),
    );
    expect(qtyEl).toHaveAttribute('aria-invalid', 'true');
    expect(showToast).not.toHaveBeenCalled();
    expect(updateLineMock).not.toHaveBeenCalled();
    expect(qtyEl.value).toBe('2.5');
  });

  it('an invalid quantity error clears once a valid value is committed', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const qtyEl = screen.getByTestId('quote-line-qty-line-1') as HTMLInputElement;
    fireEvent.change(qtyEl, { target: { value: '0' } });
    fireEvent.blur(qtyEl);

    await waitFor(() => expect(screen.getByTestId('quote-line-qty-error-line-1')).toBeInTheDocument());
    expect(updateLineMock).not.toHaveBeenCalled();

    // Correcting the value clears the error on keystroke and commits on blur.
    fireEvent.change(qtyEl, { target: { value: '3' } });
    expect(screen.queryByTestId('quote-line-qty-error-line-1')).not.toBeInTheDocument();
    fireEvent.blur(qtyEl);
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { quantity: 3 }));
    expect(qtyEl).not.toHaveAttribute('aria-invalid');
  });

  it('keeps in-progress keystrokes when a stale refresh lands (no clobber)', async () => {
    // "edit qty→5, blur, type 7": a refresh confirming 5 must not wipe the 7 the
    // user has already typed into the still-focused field.
    const { rerender } = render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const qtyEl = screen.getByTestId('quote-line-qty-line-1') as HTMLInputElement;
    fireEvent.change(qtyEl, { target: { value: '5' } });
    fireEvent.blur(qtyEl);
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { quantity: 5 }));

    // User immediately types 7 before the refresh GET (confirming 5) lands.
    fireEvent.change(qtyEl, { target: { value: '7' } });
    const confirmedFive: QuoteDetailData = {
      ...detail,
      lines: [{ ...line, quantity: '5.00', lineTotal: '250.00' }],
    };
    rerender(<QuoteEditor detail={confirmedFive} onChanged={vi.fn()} />);

    // The 7 survives — the stale-but-changed prop did not clobber the edit.
    expect((screen.getByTestId('quote-line-qty-line-1') as HTMLInputElement).value).toBe('7');
  });

  it('a slow qty save never disables the other fields (scoped pending)', async () => {
    // Tab-through editing: commit qty, tab to price, keep typing. Only the
    // in-flight control may disable — a whole-row freeze ejects focus and eats
    // keystrokes (the scoped-pending backport from InvoiceEditor).
    let resolvePatch!: (r: Response) => void;
    updateLineMock.mockReturnValueOnce(new Promise<Response>((r) => { resolvePatch = r; }));

    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const qtyEl = screen.getByTestId('quote-line-qty-line-1') as HTMLInputElement;
    fireEvent.change(qtyEl, { target: { value: '3' } });
    fireEvent.blur(qtyEl); // commit starts; PATCH held open

    expect(qtyEl).toBeDisabled();
    expect(screen.getByTestId('quote-line-price-line-1')).not.toBeDisabled();
    expect(screen.getByTestId('quote-line-name-line-1')).not.toBeDisabled();
    expect(screen.getByTestId('quote-line-desc-line-1')).not.toBeDisabled();

    resolvePatch({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response);
    await waitFor(() => expect(qtyEl).not.toBeDisabled());
  });

  it('attaching a line image uploads it, then PATCHes the line with the imageId', async () => {
    vi.mocked(uploadQuoteImage).mockResolvedValue(
      { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: { imageId: 'img-9' } }) } as unknown as Response,
    );
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    const file = new File(['png-bytes'], 'u7-pro.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('quote-line-image-input-line-1'), { target: { files: [file] } });

    await waitFor(() => expect(uploadQuoteImage).toHaveBeenCalledWith('q-1', file));
    await waitFor(() =>
      expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { imageId: 'img-9' }),
    );
  });

  it('removing a line image PATCHes imageId: null', async () => {
    const withImage: QuoteDetailData = {
      ...detail,
      lines: [{ ...line, imageId: 'img-9' }],
    };
    render(<QuoteEditor detail={withImage} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-line-image-remove-line-1'));
    await waitFor(() =>
      expect(updateLineMock).toHaveBeenCalledWith('q-1', 'line-1', { imageId: null }),
    );
  });
});
