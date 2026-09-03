import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';
import { _resetShowMarginMemoryForTests } from './billingUi';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() (billing-RBAC UI gating) reads grants off the store; grant
  // the admin wildcard so every gated control renders and these tests exercise
  // full functionality.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function draft(lines: InvoiceDetail['lines'], extra: Partial<InvoiceDetail['invoice']> = {}): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', amountPaid: '0.00', balance: '0.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
      ...extra,
    },
    lines,
  };
}

const manualLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: null, description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

describe('InvoiceEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Margin visibility persists to localStorage — start each test from the
    // default (hidden); tests that need the panel opt in explicitly.
    localStorage.clear();
    // The memory mirror deliberately outlives localStorage.clear(), so a suite
    // that ever clicks a MarginToggle would leak the preference into its
    // neighbours without this.
    _resetShowMarginMemoryForTests();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      return json({ data: {} });
    });
  });

  // Issue / Issue & Send behavior (disabled-without-visible-lines, toasts,
  // in-flight label) moved to InvoiceActions.test.tsx with the buttons — the
  // actions now live in the workspace header (InvoiceActions), not the editor.

  it('renders an editable line (full-width description row)', async () => {
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    // Name/description are now editable inputs (full-width description row) rather
    // than static text; the legacy name-less line shows its description in the box.
    expect(screen.getByTestId('invoice-line-desc-line-1')).toHaveValue('Consulting');
  });

  it('characterizes a contract overage sibling as editable while a bundle child is read-only (#3205 W04)', async () => {
    const overage = {
      ...manualLine, id: 'over', sourceType: 'contract' as const, parentLineId: null,
      description: 'Overage: 1 above 25 included — Endpoints', quantity: '1.00', unitPrice: '12.00', lineTotal: '12.00',
    };
    const child = {
      ...manualLine, id: 'child', sourceType: 'bundle' as const, parentLineId: 'over',
      description: 'Bundle component', customerVisible: false,
    };
    render(<InvoiceEditor detail={draft([overage, child])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-line-desc-over')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-line-remove-over')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-line-child-child')).toHaveTextContent('Bundle component');
    expect(screen.queryByTestId('invoice-line-desc-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-line-remove-child')).not.toBeInTheDocument();
  });

  it('warns when a line is taxable but no tax rate is configured', async () => {
    const taxable = { ...manualLine, taxable: true };
    const { rerender } = render(<InvoiceEditor detail={draft([taxable])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-tax-rate-hint')).toHaveTextContent('no tax rate is set');

    // Once a real rate exists the hint disappears (and the Tax row shows the percent).
    rerender(<InvoiceEditor detail={draft([taxable], { taxRate: '0.07', taxTotal: '7.00' })} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('invoice-tax-rate-hint')).not.toBeInTheDocument();
  });

  it('adds a manual line and triggers a reload (onChanged)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/lines' && opts?.method === 'POST') return json({ data: { id: 'line-2' } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // Catalog is the default add mode now; switch to the manual line form.
    fireEvent.click(screen.getByTestId('invoice-add-mode-manual'));
    fireEvent.change(screen.getByTestId('invoice-manual-desc'), { target: { value: 'New work' } });
    fireEvent.change(screen.getByTestId('invoice-manual-qty'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('invoice-manual-price'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('invoice-add-line-submit'));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find((c) => c[0] === '/invoices/inv-1/lines');
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toMatchObject({
      description: 'New work', quantity: 3, unitPrice: 20, taxable: false,
    });
  });

  it('adds a catalog item via the typeahead picker', async () => {
    const catItem = (over: Record<string, unknown>) => ({
      id: 'cat-1', partnerId: 'p1', itemType: 'service', name: 'Onboarding', sku: 'ONB-1',
      description: null, billingType: 'one_time', unitPrice: '500.00', costBasis: null,
      markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
      isBundle: false, isActive: true, createdAt: '', updatedAt: '', ...over,
    });
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [catItem({}), catItem({ id: 'bun-1', name: 'Starter Bundle', isBundle: true })] });
      if (input === '/invoices/inv-1/lines/catalog' && opts?.method === 'POST') return json({ data: { id: 'line-9' } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // Catalog is the default mode — search and pick via the typeahead.
    fireEvent.change(screen.getByTestId('invoice-catalog-picker-input'), { target: { value: 'Onb' } });
    fireEvent.click(await screen.findByTestId('invoice-catalog-picker-option-cat-1'));
    fireEvent.change(screen.getByTestId('invoice-pick-qty'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('invoice-catalog-add'));

    await waitFor(() => {
      const c = fetchMock.mock.calls.find((call) => call[0] === '/invoices/inv-1/lines/catalog');
      expect(c).toBeTruthy();
      expect(JSON.parse((c![1] as RequestInit).body as string)).toMatchObject({ catalogItemId: 'cat-1', quantity: 2 });
    });
  });

  it('renders the internal margin summary from line costs', async () => {
    // The panel honors the billing-wide persisted "show cost & margin"
    // preference — pre-enable it (default is hidden).
    localStorage.setItem('breeze:quote-editor-show-margin', '1');
    const costedLine = { ...manualLine, id: 'line-c', costBasis: '30.00', quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00' };
    render(<InvoiceEditor detail={draft([costedLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    // revenue 100 − cost (30×2 = 60) = 40 net.
    expect(screen.getByTestId('invoice-margin-cost')).toHaveTextContent('$60.00');
    expect(screen.getByTestId('invoice-margin-net-onetime')).toHaveTextContent('$40.00');
    expect(screen.queryByTestId('invoice-margin-net-monthly')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-margin-missing-cost')).not.toBeInTheDocument();
  });

  it('flags a missing cost in the margin summary', async () => {
    localStorage.setItem('breeze:quote-editor-show-margin', '1');
    // manualLine has costBasis null → excluded from net and counted as missing.
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-margin-missing-cost')).toHaveTextContent('1 line missing a cost');
  });

  it('flags unapproved-time lines with a warning banner', async () => {
    const unapproved = { ...manualLine, id: 'line-u', isUnapprovedTime: true };
    render(<InvoiceEditor detail={draft([unapproved])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-unapproved-warning')).toBeInTheDocument());
  });

  // ── Save-grammar parity backport (Task 6): scoped pending, commit guards,
  //    dirty/saved cues, resync guard — ported from QuoteEditor. ─────────────

  const patchCalls = (lineId: string) =>
    fetchMock.mock.calls.filter(
      (c) => c[0] === `/invoices/inv-1/lines/${lineId}` && (c[1] as RequestInit)?.method === 'PATCH',
    );

  it('qty blur with a non-numeric value does not PATCH and surfaces an error', async () => {
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const qty = screen.getByTestId('invoice-line-qty-line-1');
    fireEvent.change(qty, { target: { value: 'abc' } });
    fireEvent.blur(qty);

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    expect(patchCalls('line-1')).toHaveLength(0);
  });

  it('qty blur with a non-positive value is rejected without a PATCH', async () => {
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const qty = screen.getByTestId('invoice-line-qty-line-1');
    fireEvent.change(qty, { target: { value: '-1' } });
    fireEvent.blur(qty);

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('greater than 0') }),
      ),
    );
    expect(patchCalls('line-1')).toHaveLength(0);
  });

  it('re-typing the same price in a different format ("3.00" over "3") fires no PATCH', async () => {
    const priced = { ...manualLine, unitPrice: '3.00', lineTotal: '6.00' };
    render(<InvoiceEditor detail={draft([priced])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const price = screen.getByTestId('invoice-line-price-line-1');
    fireEvent.change(price, { target: { value: '3' } }); // numerically identical to 3.00
    fireEvent.blur(price);

    // Give any (erroneous) async PATCH a chance to fire before asserting none did.
    await new Promise((r) => setTimeout(r, 0));
    expect(patchCalls('line-1')).toHaveLength(0);
  });

  it('an in-flight PATCH on one line does not disable another line', async () => {
    const l1 = { ...manualLine, id: 'line-1' };
    const l2 = { ...manualLine, id: 'line-2', description: 'Other' };
    // Hold the PATCH open so line-1's save stays in flight while we inspect line-2.
    let releasePatch: (v: Response) => void = () => {};
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/lines/line-1' && opts?.method === 'PATCH') {
        return new Promise<Response>((resolve) => { releasePatch = resolve; });
      }
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([l1, l2])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const qty1 = screen.getByTestId('invoice-line-qty-line-1');
    fireEvent.change(qty1, { target: { value: '9' } });
    fireEvent.blur(qty1);

    // line-1's save is in flight; line-2's inputs must remain usable.
    await waitFor(() => expect(patchCalls('line-1')).toHaveLength(1));
    expect(screen.getByTestId('invoice-line-qty-line-2')).not.toBeDisabled();
    expect(screen.getByTestId('invoice-line-price-line-2')).not.toBeDisabled();

    releasePatch(json({ data: {} }));
  });

  it('a background refresh does not clobber a qty field being edited', async () => {
    const { rerender } = render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const qty = screen.getByTestId('invoice-line-qty-line-1');
    fireEvent.change(qty, { target: { value: '9' } }); // mid-edit, not yet blurred

    // A background poll re-supplies the invoice prop with a different server qty.
    const serverEcho = { ...manualLine, quantity: '5.00', lineTotal: '250.00' };
    rerender(<InvoiceEditor detail={draft([serverEcho])} onChanged={vi.fn()} />);

    // The user's in-progress "9" survives the resync.
    expect(screen.getByTestId('invoice-line-qty-line-1')).toHaveValue(9);
  });

  it('a background refresh does not clobber a price field being edited', async () => {
    // The price resync guard is symmetric with qty's (its own `priceEdited` ref),
    // so a mid-type unit price must likewise survive a server echo.
    const { rerender } = render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const price = screen.getByTestId('invoice-line-price-line-1');
    fireEvent.change(price, { target: { value: '75' } }); // mid-edit, not yet blurred

    const serverEcho = { ...manualLine, unitPrice: '50.00', lineTotal: '100.00' };
    rerender(<InvoiceEditor detail={draft([serverEcho])} onChanged={vi.fn()} />);

    // The user's in-progress "75" survives; the server's 50 does not clobber it.
    expect(screen.getByTestId('invoice-line-price-line-1')).toHaveValue(75);
  });

  it('a settled price field DOES re-adopt a new server value on refresh', async () => {
    // The guard only protects an ACTIVELY-edited field: an untouched price must
    // still track the server's canonical value when a background poll lands.
    const { rerender } = render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-line-price-line-1')).toHaveValue(50);

    const serverEcho = { ...manualLine, unitPrice: '65.00', lineTotal: '130.00' };
    rerender(<InvoiceEditor detail={draft([serverEcho])} onChanged={vi.fn()} />);

    expect(screen.getByTestId('invoice-line-price-line-1')).toHaveValue(65);
  });

  it('disables the notes textarea while its own save is in flight (busy cue)', async () => {
    // Visual busy-cue parity with the quote editor's terms field: the textarea
    // reflects isPending('notes'). The inFlight guard already blocks a double
    // PATCH; this just makes the in-flight window visible.
    let releasePatch: (v: Response) => void = () => {};
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') {
        return new Promise<Response>((resolve) => { releasePatch = resolve; });
      }
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const notes = screen.getByTestId('invoice-notes');
    fireEvent.change(notes, { target: { value: 'A note' } });
    fireEvent.blur(notes); // dirty → saveNotes → PATCH held open

    await waitFor(() => expect(notes).toBeDisabled());
    releasePatch(json({ data: {} }));
    await waitFor(() => expect(notes).not.toBeDisabled());
  });

  it('disables the terms textarea while its own save is in flight (busy cue)', async () => {
    // Symmetric with the notes field — the terms disable also reflects
    // isPending('terms').
    let releasePatch: (v: Response) => void = () => {};
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') {
        return new Promise<Response>((resolve) => { releasePatch = resolve; });
      }
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const terms = screen.getByTestId('invoice-terms');
    fireEvent.change(terms, { target: { value: 'Net 30' } });
    fireEvent.blur(terms); // dirty → saveTerms → PATCH held open

    await waitFor(() => expect(terms).toBeDisabled());
    releasePatch(json({ data: {} }));
    await waitFor(() => expect(terms).not.toBeDisabled());
  });

  it('editing the T&C textarea and blurring issues PATCH /invoices/:id with { termsAndConditions }', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') return json({ data: {} });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const textarea = screen.getByTestId('invoice-terms');
    fireEvent.change(textarea, { target: { value: 'Net 30' } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => c[0] === '/invoices/inv-1' && (c[1] as RequestInit)?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toMatchObject({
        termsAndConditions: 'Net 30',
      });
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Terms saved' }));
  });

  it('tells "catalog is empty" apart from "catalog failed to load", and offers a retry', async () => {
    // Rendering the empty state on a failed load sends a tech off to re-create
    // items that already exist — and the rejection used to be voided entirely,
    // so there was no toast either.
    let fail = true;
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) {
        // A 200 with an unparseable body — the shape a proxy/truncation
        // produces, and the one an `!res.ok` check alone sails straight past.
        if (fail) return ({ ok: true, status: 200, statusText: 'OK', json: () => Promise.reject(new Error('bad json')) }) as unknown as Response;
        return json({ data: [{ id: 'cat-1', name: 'Widget', unitPrice: '10.00', isBundle: false }] });
      }
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-catalog-error')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-catalog-empty')).not.toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

    fail = false;
    fireEvent.click(screen.getByTestId('invoice-catalog-retry'));
    await waitFor(() => expect(screen.getByTestId('invoice-catalog-picker')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-catalog-error')).not.toBeInTheDocument();
  });

  it('namespaces its unsaved-hint ids with the invoice prefix so quote ids cannot collide', async () => {
    // unsavedHintId takes three same-typed strings and the invoice side hand
    // types the prefix at every call site, so a swap or a typo compiles fine.
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const qty = screen.getByTestId('invoice-line-qty-line-1');
    fireEvent.change(qty, { target: { value: '7' } });

    await waitFor(() => expect(document.getElementById('invoice-line-qty-unsaved-line-1')).toBeInTheDocument());
    expect(qty.getAttribute('aria-describedby')).toContain('invoice-line-qty-unsaved-line-1');
    // The quote namespace must be untouched by the invoice editor.
    expect(document.getElementById('quote-line-qty-unsaved-line-1')).toBeNull();
  });

  it('does not stamp "Saved" when an add-line entry fails validation', async () => {
    // Validation early-returns used to run INSIDE runScoped, where a plain
    // `return` is indistinguishable from a completed save — so a rejected
    // quantity produced an error toast AND a fresh "Saved 3:14 PM".
    render(<InvoiceEditor detail={draft([])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-add-mode-manual'));
    fireEvent.change(screen.getByTestId('invoice-manual-desc'), { target: { value: 'Thing' } });
    fireEvent.change(screen.getByTestId('invoice-manual-qty'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('invoice-add-line-submit'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/lines') && (c[1] as RequestInit)?.method === 'POST')).toBe(false);
    expect(screen.queryByTestId('invoice-editor-last-saved')).not.toBeInTheDocument();
  });

  it('toasts the currency-gap message when the catalog add answers NO_PRICE_FOR_CURRENCY (#3775)', async () => {
    const catItem = {
      id: 'cat-1', partnerId: 'p1', itemType: 'service', name: 'Onboarding', sku: 'ONB-1',
      description: null, billingType: 'one_time', unitPrice: '500.00', costBasis: null, costCurrency: 'USD',
      markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
      isBundle: false, isActive: true, createdAt: '', updatedAt: '', prices: [{ currencyCode: 'USD', unitPrice: '500.00' }],
    };
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [catItem] });
      if (input === '/invoices/inv-1/lines/catalog' && opts?.method === 'POST') {
        return json({ error: 'No price in EUR', code: 'NO_PRICE_FOR_CURRENCY' }, false, 409);
      }
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([], { currencyCode: 'EUR' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('invoice-catalog-picker-input'), { target: { value: 'Onb' } });
    // The picker shows the EUR gap rather than the USD row or the unitPrice mirror.
    expect(await screen.findByTestId('invoice-catalog-picker-noprice-cat-1')).toHaveTextContent('No EUR price');
    fireEvent.click(screen.getByTestId('invoice-catalog-picker-option-cat-1'));
    fireEvent.click(screen.getByTestId('invoice-catalog-add'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'No EUR price for this item. Add one in the catalog or enter a manual line.',
    })));
  });

  it('shows the price-book price in the invoice currency in the picker', async () => {
    const catItem = {
      id: 'cat-1', partnerId: 'p1', itemType: 'service', name: 'Onboarding', sku: 'ONB-1',
      description: null, billingType: 'one_time', unitPrice: '500.00', costBasis: null, costCurrency: 'USD',
      markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
      isBundle: false, isActive: true, createdAt: '', updatedAt: '',
      prices: [{ currencyCode: 'EUR', unitPrice: '420.00' }, { currencyCode: 'USD', unitPrice: '500.00' }],
    };
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [catItem] });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([], { currencyCode: 'EUR' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('invoice-catalog-picker-input'), { target: { value: 'Onb' } });
    const price = await screen.findByTestId('invoice-catalog-picker-price-cat-1');
    expect(price).toHaveTextContent('420.00');
    expect(price).not.toHaveTextContent('500');
  });

  // #3277 — the free-text fields re-sync from the server value DURING RENDER,
  // not from a `useEffect`. A deferred effect can flush AFTER a keystroke it
  // never saw and overwrite it with the pre-edit value, silently clearing the
  // dirty flag; `saveNotes`/`saveTerms` then short-circuit on `!dirty` and no
  // PATCH is sent at all. That is what made the InvoiceWorkspace queued-Issue
  // tests flaky, filed five times from 2026-07-29 on, across
  // #2925/#3219/#3277/#3980/#4033.
  //
  // The ordering hazard itself is only reachable by out-racing React's
  // scheduler, so these cases pin the observable contract instead: a re-render
  // whose server value is UNCHANGED after normalisation must never touch the
  // draft — and must leave it SAVEABLE, which is the part that actually broke —
  // while one whose server value genuinely changed must replace it. The
  // null → '' case is the deterministic discriminator — the old
  // `useEffect(..., [invoice.notes])` compared the RAW prop, so that round-trip
  // re-ran the effect and discarded the draft.
  describe('server value re-sync', () => {
    it('keeps a dirty notes draft when a refetch reports the same value under a different raw form (null → "")', async () => {
      const { rerender } = render(<InvoiceEditor detail={draft([manualLine], { notes: null })} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('invoice-notes'), { target: { value: 'Half-typed note' } });
      expect(screen.getByTestId('invoice-notes')).toHaveValue('Half-typed note');

      // A quiet refetch lands carrying '' where the previous payload had null.
      // Nothing the user cares about changed, so the draft must survive.
      rerender(<InvoiceEditor detail={draft([manualLine], { notes: '' })} onChanged={vi.fn()} />);
      expect(screen.getByTestId('invoice-notes')).toHaveValue('Half-typed note');

      // …and it must still be SAVEABLE. The visible text is only a proxy: the
      // damage in #3277 was the silently-cleared `notesDirty`, which makes
      // `saveNotes()` short-circuit so the blur sends nothing at all. Asserting
      // the text alone would pass for a regression that clears the flag without
      // touching the value, which is the same silent data loss wearing a
      // different hat — so assert the PATCH actually goes out.
      fireEvent.blur(screen.getByTestId('invoice-notes'));
      await waitFor(() => expect(fetchMock.mock.calls.some(
        (c) => (c[1] as RequestInit)?.method === 'PATCH'
          && String((c[1] as RequestInit)?.body).includes('Half-typed note'),
      )).toBe(true));
    });

    it('keeps a dirty terms draft across the same null → "" round-trip', async () => {
      const { rerender } = render(<InvoiceEditor detail={draft([manualLine], { termsAndConditions: null })} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('invoice-terms'), { target: { value: 'Net 15' } });
      expect(screen.getByTestId('invoice-terms')).toHaveValue('Net 15');

      rerender(<InvoiceEditor detail={draft([manualLine], { termsAndConditions: '' })} onChanged={vi.fn()} />);
      expect(screen.getByTestId('invoice-terms')).toHaveValue('Net 15');

      // Same reason as the notes case: prove the edit is still saveable, not
      // merely still visible.
      fireEvent.blur(screen.getByTestId('invoice-terms'));
      await waitFor(() => expect(fetchMock.mock.calls.some(
        (c) => (c[1] as RequestInit)?.method === 'PATCH'
          && String((c[1] as RequestInit)?.body).includes('Net 15'),
      )).toBe(true));
    });

    it('DOES replace the draft when the server value genuinely changes', async () => {
      const { rerender } = render(<InvoiceEditor detail={draft([manualLine], { notes: 'Original' })} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
      expect(screen.getByTestId('invoice-notes')).toHaveValue('Original');

      fireEvent.change(screen.getByTestId('invoice-notes'), { target: { value: 'Local draft' } });
      expect(screen.getByTestId('invoice-notes')).toHaveValue('Local draft');

      // Someone else's edit arrived. The local draft is stale — replacing it is
      // the deliberate behaviour this fix preserves, not a regression.
      rerender(<InvoiceEditor detail={draft([manualLine], { notes: 'Updated on the server' })} onChanged={vi.fn()} />);
      expect(screen.getByTestId('invoice-notes')).toHaveValue('Updated on the server');
    });
  });
});
