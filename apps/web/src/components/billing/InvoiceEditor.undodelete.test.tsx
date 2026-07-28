// Deferred line deletion with an undo grace window (the quote editor's delete
// model, normalized onto invoices): Remove hides the row instantly and shows an
// undo toast; the real DELETE fires only when the grace window lapses (or on
// flush/unmount) — a fat-fingered Remove on a money document is recoverable.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
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

const manualLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: 'Consulting', description: null, quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

function draft(lines: InvoiceDetail['lines']): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '100.00', taxRate: null,
      taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
    },
    lines,
  };
}

const deletePosted = () =>
  fetchMock.mock.calls.some((c) => String(c[0]) === '/invoices/inv-1/lines/line-1' && (c[1] as RequestInit)?.method === 'DELETE');

const lastUndoToast = () => {
  const call = [...showToast.mock.calls].reverse().find((c) => (c[0] as { type: string }).type === 'undo');
  expect(call, 'expected an undo toast').toBeTruthy();
  return call![0] as { onUndo: () => void };
};

describe('InvoiceEditor — undo-able line deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      return json({ data: {} });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the row immediately with an undo toast — the DELETE waits for the grace window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));

    // Gone from the UI at once, but nothing sent yet — still undoable.
    expect(screen.queryByTestId('invoice-line-line-1')).not.toBeInTheDocument();
    expect(deletePosted()).toBe(false);
    lastUndoToast();

    // Grace window lapses → the real DELETE fires.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(deletePosted()).toBe(true);
  });

  it('undo restores the row and the DELETE never fires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));
    act(() => { lastUndoToast().onUndo(); });

    expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(deletePosted()).toBe(false);
  });

  it('reports pending edits while a deletion sits in its grace window, and quiesces on flush success WITHOUT needing a refetch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onPending = vi.fn();
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} onPendingEditsChange={onPending} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());
    expect(onPending).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));
    await waitFor(() => expect(onPending).toHaveBeenLastCalledWith(true));

    // Flush lands the DELETE. Quiescence must arrive from the DELETE success
    // alone — onChanged here is a bare mock (no refetch ever happens), which is
    // exactly the "quiet reload failed" shape: coupling quiescence to the
    // refetch would leave Issue held forever over a deletion that landed.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(deletePosted()).toBe(true);
    await waitFor(() => expect(onPending).toHaveBeenLastCalledWith(false));
    // The row stays hidden even though the (never-refetched) server data still
    // contains it — it IS deleted server-side.
    expect(screen.queryByTestId('invoice-line-line-1')).not.toBeInTheDocument();
  });

  it('restores the row and surfaces the error when the deferred DELETE fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/lines/line-1' && opts?.method === 'DELETE') return json({ error: { message: 'boom' } }, false, 500);
      return json({ data: {} });
    });
    const onSaveFailure = vi.fn();
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} onSaveFailure={onSaveFailure} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));
    expect(screen.queryByTestId('invoice-line-line-1')).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    // The DELETE didn't land: the row honestly reappears (it still exists
    // server-side — a silently-hidden zombie line would be billed on Issue),
    // and the failure is reported so a queued Issue cancels.
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());
    expect(onSaveFailure).toHaveBeenCalled();
  });

  it('bundle children hide and restore as one unit with their parent', async () => {
    const child: InvoiceDetail['lines'][number] = {
      ...manualLine, id: 'line-child', parentLineId: 'line-1', name: 'Component', unitPrice: '0.00', lineTotal: '0.00',
    };
    render(<InvoiceEditor detail={draft([manualLine, child])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-line-child-line-child')).toBeInTheDocument();

    // Removing the parent hides the child too (the server FK-cascades it).
    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));
    expect(screen.queryByTestId('invoice-line-line-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-line-child-line-child')).not.toBeInTheDocument();
    expect(deletePosted()).toBe(false);

    // Undo restores the whole unit.
    act(() => { lastUndoToast().onUndo(); });
    expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-line-child-line-child')).toBeInTheDocument();
  });

  it('optimistically excludes a deleted line from Subtotal/Tax/Total during the undo window (and restores them on undo)', async () => {
    // The deferred DELETE hides the row and updates margin instantly, but the
    // server totals still include the line until the flush + refetch land. For
    // the whole undo window the rail/sticky bar must render totals computed
    // from the VISIBLE lines — a money document whose Total contradicts its
    // own line table reads as broken (the quote editor's optimisticTotals
    // contract, carried over).
    const taxed: InvoiceDetail['lines'][number] = {
      ...manualLine, id: 'line-2', name: 'Hardware', quantity: '1.00', unitPrice: '50.00',
      lineTotal: '50.00', taxable: true,
    };
    const detail = draft([manualLine, taxed]);
    detail.invoice.subtotal = '150.00';
    detail.invoice.taxRate = '0.10000';
    detail.invoice.taxTotal = '5.00';
    detail.invoice.total = '155.00';
    render(<InvoiceEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-2')).toBeInTheDocument());

    // At rest the rail renders the authoritative server figures.
    expect(screen.getByTestId('invoice-subtotal')).toHaveTextContent('$150.00');
    expect(screen.getByTestId('invoice-tax')).toHaveTextContent('$5.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('$155.00');

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-2'));

    // The line is hidden and the totals immediately exclude it — including the
    // tax it carried and the sticky mobile bar's total.
    expect(screen.queryByTestId('invoice-line-line-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-subtotal')).toHaveTextContent('$100.00');
    expect(screen.getByTestId('invoice-tax')).toHaveTextContent('$0.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('$100.00');
    expect(screen.getByTestId('invoice-totals-sticky-total')).toHaveTextContent('$100.00');

    // Undo restores the row AND the authoritative server totals.
    act(() => { lastUndoToast().onUndo(); });
    expect(screen.getByTestId('invoice-line-line-2')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-subtotal')).toHaveTextContent('$150.00');
    expect(screen.getByTestId('invoice-tax')).toHaveTextContent('$5.00');
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('$155.00');
  });

  it('an Undo click after the DELETE already flushed gets a "too late" notice, not silence', async () => {
    let flush: (() => void) | null = null;
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} onRegisterPendingDeleteFlush={(f) => { flush = f; }} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));
    const undoToast = lastUndoToast();
    act(() => { flush!(); });
    await waitFor(() => expect(deletePosted()).toBe(true));

    showToast.mockClear();
    act(() => { undoToast.onUndo(); });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    // The line does not come back — the deletion is real.
    expect(screen.queryByTestId('invoice-line-line-1')).not.toBeInTheDocument();
  });

  it('unmount flushes a pending deletion instead of losing it', async () => {
    const { unmount } = render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));
    expect(deletePosted()).toBe(false);

    unmount();
    expect(deletePosted()).toBe(true);
  });

  it('the workspace flush hook fires pending DELETEs immediately (held Issue path)', async () => {
    let flush: (() => void) | null = null;
    render(
      <InvoiceEditor
        detail={draft([manualLine])}
        onChanged={vi.fn()}
        onRegisterPendingDeleteFlush={(f) => { flush = f; }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('invoice-line-line-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-line-remove-line-1'));
    expect(deletePosted()).toBe(false);
    act(() => { flush!(); });
    expect(deletePosted()).toBe(true);
  });
});
