import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceDetail from './InvoiceDetail';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
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

const line: InvoiceDetailData['lines'][number] = {
  id: 'l1', invoiceId: 'inv-1', sourceType: 'catalog', parentLineId: null, catalogItemId: 'c1',
  name: null, description: 'Widget', quantity: '1.00', unitPrice: '1000.00', costBasis: '600.00', revenueAllocation: '1000.00',
  taxable: false, customerVisible: true, lineTotal: '1000.00', isUnapprovedTime: false, sortOrder: 0, deviceCount: 0,
};

function detail(inv: Partial<InvoiceDetailData['invoice']> = {}): InvoiceDetailData {
  return {
    autopay: null,
    invoice: {
      id: 'inv-1', invoiceNumber: 'INV-0007', orgId: 'org-1', siteId: null, status: 'sent',
      currencyCode: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-30', sentAt: null, subtotal: '1000.00',
      taxRate: '0.000', taxTotal: '0.00', total: '1000.00', amountPaid: '0.00', balance: '1000.00',
      depositDue: null, billToName: 'Acme', notes: null, termsAndConditions: null, sellerSnapshot: null,
      createdAt: '2026-06-01T00:00:00Z', ...inv,
    },
    lines: [line],
  };
}

describe('InvoiceDetail deposit + due-date + request payment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.endsWith('/payments')) return json({ data: [] });
      return json({ data: { emailed: true } });
    });
  });

  it('renders no deposit strip when the invoice has no deposit', async () => {
    render(<InvoiceDetail detail={detail()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-deposit-strip')).not.toBeInTheDocument();
  });

  it('shows a deposit-due strip when a deposit is set and unmet', async () => {
    render(<InvoiceDetail detail={detail({ depositDue: '300.00' })} onChanged={vi.fn()} />);
    const strip = await screen.findByTestId('invoice-deposit-strip');
    expect(strip).toHaveTextContent('Deposit of');
    expect(strip).toHaveTextContent('$300.00');
  });

  it('shows "Deposit paid" once the deposit is met', async () => {
    render(<InvoiceDetail detail={detail({ depositDue: '300.00', amountPaid: '300.00', balance: '700.00' })} onChanged={vi.fn()} />);
    const strip = await screen.findByTestId('invoice-deposit-strip');
    expect(strip).toHaveTextContent('Deposit paid');
  });

  // #8786: while a deposit is unpaid the headline leads with what the customer's
  // Pay button charges (computeChargeNow), and the full balance stays visible.
  it('leads with "Deposit due now" while the deposit is unpaid, keeping the full balance visible', async () => {
    render(<InvoiceDetail detail={detail({ depositDue: '300.00', amountPaid: '100.00', balance: '900.00', status: 'partially_paid' })} onChanged={vi.fn()} />);
    const headline = await screen.findByTestId('invoice-detail-deposit-due-now');
    // Remaining deposit = 300 - 100, not the full 300 and not the 900 balance.
    expect(headline).toHaveTextContent('$200.00');
    expect(screen.getByTestId('invoice-detail-headline-label')).toHaveTextContent('Deposit due now');
    expect(screen.getByTestId('invoice-detail-balance')).toHaveTextContent('$900.00');
  });

  it('reverts to the balance-due headline once the deposit is met', async () => {
    render(<InvoiceDetail detail={detail({ depositDue: '300.00', amountPaid: '300.00', balance: '700.00', status: 'partially_paid' })} onChanged={vi.fn()} />);
    await screen.findByTestId('invoice-deposit-strip');
    expect(screen.queryByTestId('invoice-detail-deposit-due-now')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-detail-headline-label')).toHaveTextContent('Balance due');
    expect(screen.getByTestId('invoice-detail-balance')).toHaveTextContent('$700.00');
    expect(screen.queryByTestId('invoice-payment-fill-deposit')).not.toBeInTheDocument();
  });

  it('shows the void state, not a deposit headline, on a void invoice with an unpaid deposit', async () => {
    render(<InvoiceDetail detail={detail({ status: 'void', depositDue: '300.00' })} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('invoice-detail-void-state')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-detail-deposit-due-now')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-form')).not.toBeInTheDocument();
  });

  // A draft isn't payable yet (the portal has no Pay button for it), so nothing is "due now".
  it('keeps the balance-due headline on a draft invoice that has a deposit set', async () => {
    render(<InvoiceDetail detail={detail({ status: 'draft', depositDue: '300.00' })} onChanged={vi.fn()} />);
    await screen.findByTestId('invoice-deposit-strip');
    expect(screen.queryByTestId('invoice-detail-deposit-due-now')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-detail-headline-label')).toHaveTextContent('Balance due');
  });

  it('keeps the balance-due headline and offers no deposit chip when there is no deposit', async () => {
    render(<InvoiceDetail detail={detail()} onChanged={vi.fn()} />);
    await screen.findByTestId('invoice-payment-form');
    expect(screen.queryByTestId('invoice-detail-deposit-due-now')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-detail-headline-label')).toHaveTextContent('Balance due');
    expect(screen.queryByTestId('invoice-payment-fill-deposit')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invoice-payment-fill-balance'));
    expect(screen.getByTestId('invoice-payment-amount')).toHaveValue(1000);
  });

  it('pre-fills the record-payment amount with the remaining deposit or the full balance', async () => {
    render(<InvoiceDetail detail={detail({ depositDue: '300.00', amountPaid: '100.00', balance: '900.00', status: 'partially_paid' })} onChanged={vi.fn()} />);
    const depositChip = await screen.findByTestId('invoice-payment-fill-deposit');
    expect(depositChip).toHaveTextContent('$200.00');
    const balanceChip = screen.getByTestId('invoice-payment-fill-balance');
    expect(balanceChip).toHaveTextContent('$900.00');
    const amount = screen.getByTestId('invoice-payment-amount');
    fireEvent.click(depositChip);
    expect(amount).toHaveValue(200);
    fireEvent.click(balanceChip);
    expect(amount).toHaveValue(900);
  });

  it('records the deposit pre-fill as the payment amount', async () => {
    render(<InvoiceDetail detail={detail({ depositDue: '300.00' })} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('invoice-payment-fill-deposit'));
    fireEvent.click(screen.getByTestId('invoice-payment-submit'));
    fireEvent.click(await screen.findByTestId('invoice-payment-confirm'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/invoices/inv-1/payments' && (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body)).amount).toBe(300);
    });
  });

  it('inline-edits the due date via PATCH /invoices/:id/due-date', async () => {
    render(<InvoiceDetail detail={detail()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('invoice-due-date-edit'));
    fireEvent.change(screen.getByTestId('invoice-due-date-input'), { target: { value: '2026-07-15' } });
    fireEvent.click(screen.getByTestId('invoice-due-date-save'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/invoices/inv-1/due-date');
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ dueDate: '2026-07-15' });
    });
  });

  // The email action lives in InvoiceActions (rendered in this rail) — these
  // assert the label logic the invoice-vs-quote parity work folded in there.
  it('labels the email action "Request payment" once partially paid; composes to /send', async () => {
    render(<InvoiceDetail detail={detail({ status: 'partially_paid', amountPaid: '300.00', balance: '700.00', depositDue: '300.00' })} onChanged={vi.fn()} />);
    const btn = await screen.findByTestId('invoice-resend');
    expect(btn).toHaveTextContent('Request payment');
    fireEvent.click(btn);
    // The composer is the confirm step: fill a recipient, then send. sentAt is
    // null on this fixture, so the FIRST email still goes through /send (which
    // stamps sent_at); only a later one is a /resend.
    fireEvent.change(await screen.findByTestId('invoice-send-to'), { target: { value: 'ap@acme.test' } });
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/send')).toBe(true));
  });

  it('labels the email action "Send invoice" when nothing is paid yet', async () => {
    render(<InvoiceDetail detail={detail()} onChanged={vi.fn()} />);
    const btn = await screen.findByTestId('invoice-resend');
    expect(btn).toHaveTextContent('Send invoice');
  });

  // Once the invoice HAS been emailed, the same control re-sends — and must hit
  // /resend, which pins sent_at rather than restamping it.
  it('reads "Re-send" and POSTs /resend once sent_at is stamped', async () => {
    render(<InvoiceDetail detail={detail({ sentAt: '2026-06-02T00:00:00Z' })} onChanged={vi.fn()} />);
    const btn = await screen.findByTestId('invoice-resend');
    expect(btn).toHaveTextContent('Re-send');
    fireEvent.click(btn);
    fireEvent.change(await screen.findByTestId('invoice-send-to'), { target: { value: 'ap@acme.test' } });
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/resend')).toBe(true));
    expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/send')).toBe(false);
  });
});
