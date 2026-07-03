import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

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
});
