import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { showToast } from '../../shared/Toast';
import { fetchWithAuth } from '../../../stores/auth';
import QuoteDetail from './QuoteDetail';
import { _resetShowMarginMemoryForTests, SHOW_INTERNAL_MARGIN_KEY } from '../billingUi';
import type {
  QuoteDetail as QuoteDetailData,
  QuoteLine,
  QuoteOrder,
  QuoteOrderLine,
} from './quoteTypes';

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [{ resource: 'quotes', action: 'read' }] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

function line(overrides: Partial<QuoteLine>): QuoteLine {
  return {
    id: 'l-1', quoteId: 'q-1', blockId: null, orgId: 'org-1', sourceType: 'catalog',
    catalogItemId: null, parentLineId: null, unitCost: '450.00', sku: null, partNumber: null,
    name: 'Laptop', description: null, quantity: '1.00', unitPrice: '600.00', taxable: false,
    customerVisible: true, lineTotal: '600.00', recurrence: 'one_time', itemType: 'hardware',
    termMonths: null, billingFrequency: null, sortOrder: 0, createdAt: '2026-07-13T00:00:00Z',
    procurementSource: null, vendorSku: null, manufacturer: null,
    ...overrides,
  };
}

function alloc(overrides: Partial<QuoteOrderLine> = {}): QuoteOrderLine {
  return {
    id: 'a-1', orderId: 'ord-1', quoteLineId: 'l-1', orderedQty: '1.00', receivedQty: '0.00',
    trackingNumber: null, eta: null, receivedAt: null, cancelledAt: null, notes: null,
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function order(lines: QuoteOrderLine[], overrides: Partial<QuoteOrder> = {}): QuoteOrder {
  return {
    id: 'ord-1', quoteId: 'q-1', procurementSource: 'td_synnex', vendorName: 'TD SYNNEX',
    orderRef: 'PO-9', orderedBy: null, orderedAt: '2026-08-01T00:00:00Z', notes: null,
    lines,
    ...overrides,
  };
}

function acceptedDetail(
  lines: QuoteLine[],
  status = 'accepted',
  pax8Order?: QuoteDetailData['pax8Order'],
  orders?: QuoteOrder[],
): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', siteId: null,
      status: status as QuoteDetailData['quote']['status'],
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00',
      billToName: 'Acme Inc.', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: '2026-07-14T00:00:00Z', declinedAt: null, convertedAt: null,
      convertedInvoiceId: null, sentAt: '2026-07-13T00:00:00Z', viewedAt: null,
      createdBy: null, createdAt: '2026-07-13T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
    },
    blocks: [],
    lines,
    pax8Order,
    orders,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  _resetShowMarginMemoryForTests();
  state.permissions = [{ resource: 'quotes', action: 'read' }];
});

describe('QuoteDetail — to-be-ordered breakdown', () => {
  it('renders SKU, part number, qty, costs and the cost total for an accepted quote with margin shown', async () => {
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', name: 'Laptop', sku: 'LT-100', partNumber: 'MFG-9', quantity: '3.00', unitCost: '450.00', unitPrice: '600.00' }),
      line({ id: 'l-2', name: 'License', sku: 'SW-1', itemType: 'software', recurrence: 'monthly', quantity: '2.00', unitCost: '10.00', unitPrice: '15.00' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    const row = screen.getByTestId('quote-order-breakdown-line-l-1');
    expect(row).toHaveTextContent('Laptop');
    expect(row).toHaveTextContent('LT-100');
    expect(row).toHaveTextContent('MFG-9');
    expect(row).toHaveTextContent('$450.00');   // unit cost
    expect(row).toHaveTextContent('$1,350.00'); // extended cost 3 × 450
    // 3×450 + 2×10 = 1,370.00
    expect(screen.getByTestId('quote-order-breakdown-cost-total')).toHaveTextContent('$1,370.00');
    expect(screen.getByTestId('quote-order-breakdown-count')).toHaveTextContent('2 items');
    // Recurring SKU line carries its cadence badge.
    expect(screen.getByTestId('quote-order-breakdown-line-l-2')).toHaveTextContent('Monthly');
  });

  it('hides cost columns and the total when the margin toggle is off, but still lists the items', async () => {
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', sku: 'LT-100', unitCost: '450.00' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-line-l-1')).toHaveTextContent('LT-100');
    expect(screen.queryByTestId('quote-order-breakdown-cost-total')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-order-breakdown-table')).not.toHaveTextContent('$450.00');
  });

  it.each(['draft', 'sent', 'viewed', 'declined', 'expired'])('renders no breakdown for a %s quote', async (status) => {
    render(<QuoteDetail detail={acceptedDetail([line({ sku: 'LT-100' })], status)} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-order-breakdown')).not.toBeInTheDocument();
  });

  it('renders the breakdown for a converted quote', async () => {
    render(<QuoteDetail detail={acceptedDetail([line({ sku: 'LT-100' })], 'converted')} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
  });

  it('renders no breakdown when the accepted quote has nothing orderable (services only)', async () => {
    render(<QuoteDetail detail={acceptedDetail([
      line({ sku: null, partNumber: null, itemType: 'service', name: 'Onboarding labor' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-order-breakdown')).not.toBeInTheDocument();
  });

  it('shows vendor identity when snapshotted', async () => {
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', sku: 'LT-100', procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE Aruba' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    const row = screen.getByTestId('quote-order-breakdown-line-l-1');
    expect(row).toHaveTextContent('TD SYNNEX');
    expect(row).toHaveTextContent('7724459'); // vendorSku wins over sku
    expect(row).toHaveTextContent('HPE Aruba');
  });

  it('flags lines with no recorded cost and keeps them out of the cost total', async () => {
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', sku: 'LT-100', quantity: '2.00', unitCost: '450.00' }),
      line({ id: 'l-2', sku: 'KB-5', name: 'Keyboard', unitCost: null }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-missing-cost')).toHaveTextContent('1 item has no cost recorded');
    expect(screen.getByTestId('quote-order-breakdown-cost-total')).toHaveTextContent('$900.00');
  });
});

describe('QuoteDetail — breakdown Pax8 cross-reference badges', () => {
  it('shows "Staged in Pax8" for a line matched to an awaiting_details order', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' })],
      'converted',
      { id: 'order-1', status: 'awaiting_details', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'pending', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-pax8-l-1')).toHaveTextContent('Staged in Pax8');
  });

  it('renders no badge for a line with no matching Pax8 order line', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' }), line({ id: 'l-2', sku: 'KB-5', name: 'Keyboard' })],
      'converted',
      { id: 'order-1', status: 'awaiting_details', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'pending', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-pax8-l-1')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-order-breakdown-pax8-l-2')).not.toBeInTheDocument();
  });

  it('shows "Ordered via Pax8" once the line has actually submitted, even while other order lines are still pending', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' })],
      'converted',
      { id: 'order-1', status: 'awaiting_details', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'succeeded', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-pax8-l-1')).toHaveTextContent('Ordered via Pax8');
  });

  it('shows a danger-toned "Pax8 failed" badge, taking precedence over a staged order status', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' })],
      'converted',
      { id: 'order-1', status: 'awaiting_details', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'failed', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    const badge = screen.getByTestId('quote-order-breakdown-pax8-l-1');
    expect(badge).toHaveTextContent('Pax8 failed');
    expect(badge.className).toContain('destructive');
  });

  it('shows the failed badge for a line still pending when the order itself failed', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' })],
      'converted',
      { id: 'order-1', status: 'failed', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'pending', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-pax8-l-1')).toHaveTextContent('Pax8 failed');
  });

  it('shows the failed badge (not ordered) when the order status is failed but this line reads succeeded', async () => {
    // Synthetic/defensive combination: deriveOrderStatus only sets order-level
    // 'failed' when EVERY line failed (apps/api/src/services/pax8OrderSubmitRepository.ts),
    // so a real order can't pair status:'failed' with a succeeded line — but the
    // badge precedence must still resolve to failed if it ever did.
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' })],
      'converted',
      { id: 'order-1', status: 'failed', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'succeeded', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-pax8-l-1')).toHaveTextContent('Pax8 failed');
  });

  it('shows a warning-toned "Pax8 needs review" badge for a needs_reconcile submit state', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' })],
      'converted',
      { id: 'order-1', status: 'awaiting_details', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'needs_reconcile', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    const badge = screen.getByTestId('quote-order-breakdown-pax8-l-1');
    expect(badge).toHaveTextContent('Pax8 needs review');
    expect(badge.className).toContain('warning');
  });

  it('shows "Staged in Pax8" for an in_flight submission — not yet a confirmed order', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100' })],
      'converted',
      { id: 'order-1', status: 'submitting', lines: [
        { sourceQuoteLineId: 'l-1', submitState: 'in_flight', quantity: '1.00' },
      ] },
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getByTestId('quote-order-breakdown-pax8-l-1')).toHaveTextContent('Staged in Pax8');
  });

  it('renders no badges when the quote has no staged Pax8 order', async () => {
    render(<QuoteDetail detail={acceptedDetail([line({ id: 'l-1', sku: 'LT-100' })], 'converted')} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-order-breakdown-pax8-l-1')).not.toBeInTheDocument();
  });
});

describe('QuoteDetail — breakdown vendor grouping', () => {
  it('groups lines by vendor with Unknown last, preserving sort order within groups', async () => {
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', sku: 'A', procurementSource: 'td_synnex', sortOrder: 1 }),
      line({ id: 'l-2', sku: 'B', procurementSource: null, sortOrder: 0 }),
      line({ id: 'l-3', sku: 'C', procurementSource: 'pax8', sortOrder: 2 }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    // Lines are sorted by sortOrder first (l-2, l-1, l-3), so first-appearance
    // vendor order is unknown → td_synnex → pax8; 'unknown' is forced last.
    const headers = screen.getAllByTestId(/^quote-order-breakdown-group-/).map((el) => el.dataset.testid);
    expect(headers).toEqual([
      'quote-order-breakdown-group-td_synnex',
      'quote-order-breakdown-group-pax8',
      'quote-order-breakdown-group-unknown',
    ]);
    expect(screen.getByTestId('quote-order-breakdown-group-td_synnex')).toHaveTextContent('TD SYNNEX');
    expect(screen.getByTestId('quote-order-breakdown-group-unknown')).toHaveTextContent('Other / unknown vendor');

    // Every line still renders, in group order.
    const rendered = Array.from(
      screen.getByTestId('quote-order-breakdown-table').querySelectorAll('tbody tr[data-testid^="quote-order-breakdown-line-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual([
      'quote-order-breakdown-line-l-1',
      'quote-order-breakdown-line-l-3',
      'quote-order-breakdown-line-l-2',
    ]);
  });

  it('suppresses group headers when every line shares one vendor', async () => {
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', sku: 'A', procurementSource: 'td_synnex' }),
      line({ id: 'l-2', sku: 'B', procurementSource: 'td_synnex' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.queryAllByTestId(/^quote-order-breakdown-group-/)).toHaveLength(0);
  });

  it('keeps the cost total spanning every line, not one per group', async () => {
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', sku: 'A', procurementSource: 'td_synnex', quantity: '2.00', unitCost: '450.00' }),
      line({ id: 'l-2', sku: 'B', procurementSource: null, quantity: '1.00', unitCost: '100.00' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());
    expect(screen.getAllByTestId('quote-order-breakdown-cost-total')).toHaveLength(1);
    expect(screen.getByTestId('quote-order-breakdown-cost-total')).toHaveTextContent('$1,000.00');
  });
});

describe('QuoteDetail — breakdown export', () => {
  const blobs: Blob[] = [];
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    blobs.length = 0;
    // jsdom has no object-URL implementation; capture the Blob downloadBlob makes.
    URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; });
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('downloads CSV without cost columns when the margin toggle is off', async () => {
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', name: 'Laptop', sku: 'LT-100', procurementSource: 'td_synnex', unitCost: '450.00' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-export-csv'));
    expect(blobs).toHaveLength(1);
    const text = await blobs[0]!.text();
    expect(text).not.toContain('450.00');
    expect(text).toContain('LT-100');
    expect(text).toContain('Laptop');
    expect(text).not.toContain('unitCost');
  });

  it('includes cost columns in the CSV when the margin toggle is on', async () => {
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', name: 'Laptop', sku: 'LT-100', quantity: '2.00', unitCost: '450.00' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-export-csv'));
    const text = await blobs[0]!.text();
    expect(text).toContain('unitCost');
    expect(text).toContain('450.00');
    expect(text).toContain('900.00'); // extended cost 2 × 450
    expect(text).toContain('USD');
  });

  it('copies TSV to the clipboard and confirms with a toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<QuoteDetail detail={acceptedDetail([
      line({ id: 'l-1', name: 'Laptop', sku: 'LT-100', manufacturer: 'HPE Aruba' }),
    ])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-copy-tsv'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const tsv = writeText.mock.calls[0]![0] as string;
    expect(tsv.split('\n')[0]).toContain('\t');
    expect(tsv).toContain('LT-100');
    expect(tsv).toContain('HPE Aruba');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces an error toast when the clipboard write is rejected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<QuoteDetail detail={acceptedDetail([line({ id: 'l-1', sku: 'LT-100' })])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-copy-tsv'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
  });
});

describe('QuoteDetail — breakdown fulfillment (chips, mark ordered, receive/cancel)', () => {
  const READ_AND_FULFILL: Perm[] = [
    { resource: 'quotes', action: 'read' },
    { resource: 'quotes', action: 'fulfill' },
  ];

  beforeEach(() => {
    state.permissions = READ_AND_FULFILL;
    vi.mocked(fetchWithAuth).mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'ord-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('shows a "Received" chip for a line whose active allocations are fully received', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [
        line({ id: 'l-1', sku: 'LT-100', quantity: '2.00' }),
        line({ id: 'l-2', sku: 'KB-5', name: 'Keyboard', quantity: '1.00' }),
      ],
      'accepted',
      undefined,
      [order([
        alloc({ id: 'a-1', quoteLineId: 'l-1', orderedQty: '2.00', receivedQty: '2.00', receivedAt: '2026-08-02T00:00:00Z' }),
      ])],
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    expect(screen.getByTestId('quote-order-breakdown-status-l-1')).toHaveTextContent('Received');
    // A line with no allocation reads as not ordered by the ABSENCE of a chip.
    expect(screen.queryByTestId('quote-order-breakdown-status-l-2')).not.toBeInTheDocument();
  });

  it('opens the dialog with every selected line prefilled to its unordered remainder', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [
        line({ id: 'l-1', sku: 'LT-100', quantity: '3.00' }),
        line({ id: 'l-2', sku: 'KB-5', name: 'Keyboard', quantity: '5.00' }),
      ],
      'accepted',
      undefined,
      [order([alloc({ id: 'a-1', quoteLineId: 'l-1', orderedQty: '1.00' })])],
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-select-l-1'));
    await userEvent.click(screen.getByTestId('quote-order-breakdown-select-l-2'));
    await userEvent.click(screen.getByTestId('quote-order-breakdown-mark-ordered'));

    expect(screen.getByTestId('quote-order-tracking')).toBeInTheDocument();
    // l-1 already has 1 of 3 on order → 2 remain; l-2 has nothing on order → 5.
    expect(screen.getByTestId('quote-order-tracking-qty-l-1')).toHaveValue(2);
    expect(screen.getByTestId('quote-order-tracking-qty-l-2')).toHaveValue(5);
  });

  it('POSTs the order once with a clientRequestId and the selected quote line ids', async () => {
    render(<QuoteDetail detail={acceptedDetail(
      [
        line({ id: 'l-1', sku: 'LT-100', quantity: '3.00', procurementSource: 'td_synnex' }),
        line({ id: 'l-2', sku: 'KB-5', name: 'Keyboard', quantity: '5.00', procurementSource: 'td_synnex' }),
      ],
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-select-l-1'));
    await userEvent.click(screen.getByTestId('quote-order-breakdown-select-l-2'));
    await userEvent.click(screen.getByTestId('quote-order-breakdown-mark-ordered'));
    // The Dialog autofocuses its first field on the next animation frame — let
    // that land first, or it steals focus mid-type and the keystrokes go to the
    // qty input instead of the order-ref field.
    await waitFor(() => expect(screen.getByTestId('quote-order-tracking-qty-l-1')).toHaveFocus());
    await userEvent.type(screen.getByTestId('quote-order-tracking-order-ref'), 'PO-42');
    await userEvent.click(screen.getByTestId('quote-order-tracking-submit'));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    const [path, init] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(path).toBe('/quotes/q-1/orders');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as {
      clientRequestId: string;
      orderRef?: string;
      procurementSource?: string;
      lines: { quoteLineId: string; orderedQty: number }[];
    };
    expect(body.clientRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.orderRef).toBe('PO-42');
    expect(body.procurementSource).toBe('td_synnex');
    expect(body.lines).toEqual([
      { quoteLineId: 'l-1', orderedQty: 3 },
      { quoteLineId: 'l-2', orderedQty: 5 },
    ]);
  });

  it('fires exactly one POST when the submit button is double-clicked', async () => {
    // The request is held open so the second click lands while the first is
    // still in flight — the exact double-submit a slow network produces.
    let release!: (r: Response) => void;
    vi.mocked(fetchWithAuth).mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));

    render(<QuoteDetail detail={acceptedDetail([line({ id: 'l-1', sku: 'LT-100', quantity: '2.00' })])} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('quote-order-breakdown-select-l-1'));
    await userEvent.click(screen.getByTestId('quote-order-breakdown-mark-ordered'));

    const submit = screen.getByTestId('quote-order-tracking-submit');
    await userEvent.click(submit);
    await userEvent.click(submit);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    release(new Response(JSON.stringify({ data: { id: 'ord-1' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await waitFor(() => expect(screen.queryByTestId('quote-order-tracking')).not.toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('hides the selection checkboxes and the Mark-ordered button without quotes:fulfill', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }, { resource: 'quotes', action: 'write' }];
    render(<QuoteDetail detail={acceptedDetail(
      [line({ id: 'l-1', sku: 'LT-100', quantity: '2.00' })],
      'accepted',
      undefined,
      [order([alloc({ id: 'a-1', quoteLineId: 'l-1', orderedQty: '2.00' })])],
    )} />);
    await waitFor(() => expect(screen.getByTestId('quote-order-breakdown')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-order-breakdown-mark-ordered')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-order-breakdown-select-l-1')).not.toBeInTheDocument();
    // Read-only view still SHOWS the state, it just can't change it.
    expect(screen.getByTestId('quote-order-breakdown-status-l-1')).toHaveTextContent('Ordered');
    expect(screen.queryByTestId('quote-order-breakdown-receive-a-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-order-breakdown-cancel-a-1')).not.toBeInTheDocument();
  });
});
