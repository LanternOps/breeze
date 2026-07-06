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
  taxable: false, customerVisible: true, lineTotal: '1000.00', isUnapprovedTime: false, sortOrder: 0,
};

function detail(inv: Partial<InvoiceDetailData['invoice']> = {}): InvoiceDetailData {
  return {
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

  it('labels the re-send action "Request payment" once partially paid; POSTs /send', async () => {
    render(<InvoiceDetail detail={detail({ status: 'partially_paid', amountPaid: '300.00', balance: '700.00', depositDue: '300.00' })} onChanged={vi.fn()} />);
    const btn = await screen.findByTestId('invoice-request-payment');
    expect(btn).toHaveTextContent('Request payment');
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/send')).toBe(true));
  });

  it('labels the re-send action "Send invoice" when nothing is paid yet', async () => {
    render(<InvoiceDetail detail={detail()} onChanged={vi.fn()} />);
    const btn = await screen.findByTestId('invoice-request-payment');
    expect(btn).toHaveTextContent('Send invoice');
  });
});
