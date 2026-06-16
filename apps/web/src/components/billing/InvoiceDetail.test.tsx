import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceDetail from './InvoiceDetail';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const lines: InvoiceDetailData['lines'] = [
  {
    id: 'l1', invoiceId: 'inv-1', sourceType: 'catalog', parentLineId: null, catalogItemId: 'c1',
    description: 'Widget', quantity: '1.00', unitPrice: '120.00', costBasis: '80.00', revenueAllocation: '120.00',
    taxable: true, customerVisible: true, lineTotal: '120.00', isUnapprovedTime: false, sortOrder: 0,
  },
  {
    id: 'l2', invoiceId: 'inv-1', sourceType: 'bundle', parentLineId: 'l1', catalogItemId: 'c2',
    description: 'Hidden component', quantity: '1.00', unitPrice: '0.00', costBasis: '10.00', revenueAllocation: null,
    taxable: false, customerVisible: false, lineTotal: '0.00', isUnapprovedTime: false, sortOrder: 0,
  },
];

const issued: InvoiceDetailData = {
  invoice: {
    id: 'inv-1', invoiceNumber: 'INV-0007', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-30', subtotal: '120.00',
    taxRate: '0.000', taxTotal: '0.00', total: '120.00', amountPaid: '0.00', balance: '120.00',
    billToName: 'Acme', notes: null, createdAt: '2026-06-01T00:00:00Z',
  },
  lines,
};

describe('InvoiceDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.endsWith('/payments')) return json({ data: [] });
      return json({ data: {} });
    });
  });

  it('hides cost/margin and hidden components until accounting view is on', async () => {
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());

    // Customer view: hidden bundle child not rendered, no cost column.
    expect(screen.queryByTestId('invoice-detail-line-l2')).not.toBeInTheDocument();
    expect(screen.queryByText('Cost')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('invoice-accounting-toggle'));
    expect(screen.getByTestId('invoice-detail-line-l2')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('Margin')).toBeInTheDocument();
  });

  it('records a payment via the form', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.endsWith('/payments') && opts?.method === 'POST') return json({ data: { id: 'pay-1' } });
      if (input.endsWith('/payments')) return json({ data: [] });
      return json({ data: {} });
    });
    render(<InvoiceDetail detail={issued} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-payment-form')).toBeInTheDocument());

    // Submit disabled until an amount is entered.
    expect(screen.getByTestId('invoice-payment-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('invoice-payment-amount'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('invoice-payment-method'), { target: { value: 'check' } });
    fireEvent.click(screen.getByTestId('invoice-payment-submit'));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/payments') && (c[1] as RequestInit)?.method === 'POST');
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toMatchObject({ amount: 50, method: 'check' });
  });

  it('shows the void action for an issued invoice and opens the dialog', async () => {
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('invoice-void-open'));
    expect(screen.getByTestId('invoice-void-dialog')).toBeInTheDocument();
    // Void submit disabled until a reason is entered.
    expect(screen.getByTestId('invoice-void-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('invoice-void-reason'), { target: { value: 'Duplicate' } });
    expect(screen.getByTestId('invoice-void-submit')).not.toBeDisabled();
  });

  it('shows "Send payment link" when Stripe is connected and POSTs pay-link', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.endsWith('/pay-link') && opts?.method === 'POST') return json({ data: { url: 'https://checkout.stripe.com/x' } });
      if (input.endsWith('/payments')) return json({ data: [] });
      return json({ data: {} });
    });
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<InvoiceDetail detail={{ ...issued, stripeConnected: true }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-stripe-nudge')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invoice-pay-link'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/pay-link') && (c[1] as RequestInit)?.method === 'POST')).toBe(true);
    });
  });

  it('shows a connect-Stripe nudge (no pay-link) when not connected', async () => {
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-stripe-nudge')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-pay-link')).not.toBeInTheDocument();
  });

  it('badges Stripe payments as Online and hides manual void on them', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.endsWith('/payments')) return json({ data: [
        { id: 'p1', invoiceId: 'inv-1', amount: '120.00', method: 'card', reference: 'pi_x', receivedAt: '2026-06-10', note: null, createdAt: '', source: 'stripe' },
      ] });
      return json({ data: {} });
    });
    render(<InvoiceDetail detail={{ ...issued, stripeConnected: true }} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-payment-p1')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-payment-online-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-void-p1')).not.toBeInTheDocument();
  });
});
