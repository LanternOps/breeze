import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuoteOrderAllocationRow, QuoteOrderTrackingDialog } from './QuoteOrderTracking';
import { formatDate, type QuoteOrderLine } from './quoteTypes';

const mocks = vi.hoisted(() => ({
  createQuoteOrder: vi.fn(),
  updateQuoteOrderLine: vi.fn(),
}));

vi.mock('../../../lib/api/quotes', () => ({
  createQuoteOrder: mocks.createQuoteOrder,
  updateQuoteOrder: vi.fn(),
  updateQuoteOrderLine: mocks.updateQuoteOrderLine,
}));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

function ok(): Response {
  return new Response(JSON.stringify({ data: { id: 'a-1' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function alloc(overrides: Partial<QuoteOrderLine> = {}): QuoteOrderLine {
  return {
    id: 'a-1', orderId: 'ord-1', quoteLineId: 'l-1', orderedQty: '2.00', receivedQty: '0.00',
    trackingNumber: null, eta: null, receivedAt: null, cancelledAt: null, notes: null,
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function renderRow(allocation: QuoteOrderLine, canFulfill = true, onChanged = vi.fn()) {
  render(
    <table>
      <tbody>
        <QuoteOrderAllocationRow
          quoteId="q-1"
          allocation={allocation}
          vendorLabel="TD SYNNEX"
          orderRef="PO-9"
          colSpan={5}
          canFulfill={canFulfill}
          onChanged={onChanged}
        />
      </tbody>
    </table>,
  );
  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createQuoteOrder.mockResolvedValue(ok());
  mocks.updateQuoteOrderLine.mockResolvedValue(ok());
});

describe('QuoteOrderAllocationRow', () => {
  it('marks an allocation fully received and reloads the quote', async () => {
    const onChanged = renderRow(alloc({ orderedQty: '2.00', receivedQty: '0.00' }));

    await userEvent.click(screen.getByTestId('quote-order-breakdown-receive-a-1'));

    await waitFor(() => expect(mocks.updateQuoteOrderLine).toHaveBeenCalledTimes(1));
    expect(mocks.updateQuoteOrderLine).toHaveBeenCalledWith('q-1', 'ord-1', 'a-1', { receivedQty: 2 });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('cancels an allocation', async () => {
    const onChanged = renderRow(alloc());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-cancel-a-1'));

    await waitFor(() => expect(mocks.updateQuoteOrderLine).toHaveBeenCalledTimes(1));
    expect(mocks.updateQuoteOrderLine).toHaveBeenCalledWith('q-1', 'ord-1', 'a-1', { cancelled: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('shows tracking and ETA when recorded', async () => {
    renderRow(alloc({ trackingNumber: '1Z999', eta: '2026-08-10' }));
    const row = screen.getByTestId('quote-order-breakdown-allocation-a-1');
    expect(row).toHaveTextContent('1Z999');
    // The ETA renders through the shared date formatter, same as the lifecycle strip.
    expect(row).toHaveTextContent(formatDate('2026-08-10'));
  });

  it('offers no actions on a cancelled allocation', async () => {
    renderRow(alloc({ cancelledAt: '2026-08-02T00:00:00Z' }));
    expect(screen.getByTestId('quote-order-breakdown-allocation-a-1')).toHaveTextContent('Cancelled');
    expect(screen.queryByTestId('quote-order-breakdown-receive-a-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-order-breakdown-cancel-a-1')).not.toBeInTheDocument();
  });

  it('drops the receive action once the allocation is fully received', async () => {
    renderRow(alloc({ orderedQty: '2.00', receivedQty: '2.00', receivedAt: '2026-08-02T00:00:00Z' }));
    expect(screen.queryByTestId('quote-order-breakdown-receive-a-1')).not.toBeInTheDocument();
    // Cancelling a received allocation is still a legitimate correction.
    expect(screen.getByTestId('quote-order-breakdown-cancel-a-1')).toBeInTheDocument();
  });

  it('renders read-only without quotes:fulfill', async () => {
    renderRow(alloc(), false);
    expect(screen.queryByTestId('quote-order-breakdown-receive-a-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-order-breakdown-cancel-a-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-order-breakdown-allocation-a-1')).toHaveTextContent('TD SYNNEX');
  });
});

describe('QuoteOrderTrackingDialog', () => {
  const candidates = [
    { lineId: 'l-1', title: 'Laptop', remainder: '2.00', procurementSource: 'td_synnex' },
  ];

  it('labels every input and closes on Escape without submitting', async () => {
    const onClose = vi.fn();
    render(
      <QuoteOrderTrackingDialog
        open
        quoteId="q-1"
        candidates={candidates}
        onClose={onClose}
        onChanged={vi.fn()}
      />,
    );

    // Every control is reachable by its visible label (no placeholder-only inputs).
    expect(screen.getByLabelText('Vendor')).toBeInTheDocument();
    expect(screen.getByLabelText('Order reference')).toBeInTheDocument();
    expect(screen.getByLabelText('Tracking number')).toBeInTheDocument();
    expect(screen.getByLabelText('Expected arrival')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity to order for Laptop')).toBeInTheDocument();

    // Escape only reaches the Dialog's keydown handler when focus is inside the
    // panel (real users are focused there; jsdom starts on <body>).
    await userEvent.click(screen.getByLabelText('Vendor'));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.createQuoteOrder).not.toHaveBeenCalled();
  });

  it('prefills the vendor from a shared procurement source and blanks it for a mixed selection', async () => {
    const { unmount } = render(
      <QuoteOrderTrackingDialog open quoteId="q-1" candidates={candidates} onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    expect(screen.getByLabelText('Vendor')).toHaveValue('TD SYNNEX');
    unmount();

    render(
      <QuoteOrderTrackingDialog
        open
        quoteId="q-1"
        candidates={[
          ...candidates,
          { lineId: 'l-2', title: 'Keyboard', remainder: '1.00', procurementSource: 'pax8' },
        ]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Vendor')).toHaveValue('');
  });

  it('refuses to submit a non-positive quantity', async () => {
    render(
      <QuoteOrderTrackingDialog open quoteId="q-1" candidates={candidates} onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    await userEvent.clear(screen.getByTestId('quote-order-tracking-qty-l-1'));
    await userEvent.type(screen.getByTestId('quote-order-tracking-qty-l-1'), '0');
    expect(screen.getByTestId('quote-order-tracking-submit')).toBeDisabled();
    expect(mocks.createQuoteOrder).not.toHaveBeenCalled();
  });
});
