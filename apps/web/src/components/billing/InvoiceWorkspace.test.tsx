import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceWorkspace from './InvoiceWorkspace';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() reads grants off the store; grant the admin wildcard so the
  // Issue controls render and the full flow is exercised.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const line = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

function invoice(over: Record<string, unknown>) {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '100.00', taxRate: null,
      taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z', ...over,
    },
    lines: [line],
    stripeConnected: false,
  };
}

describe('InvoiceWorkspace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a draft as the editor with a "Draft invoice" header', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1') return json({ data: invoice({}) });
      return json({ data: {} });
    });
    render(<InvoiceWorkspace invoiceId="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-workspace-title')).toHaveTextContent('Draft invoice'));
    expect(screen.getByTestId('invoice-editor')).toBeInTheDocument();
  });

  it('surfaces an error card when the invoice fails to load', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/invoices/inv-1') return json(null, false, 500);
      return json({ data: {} });
    });
    render(<InvoiceWorkspace invoiceId="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-workspace-error')).toBeInTheDocument());
  });

  // #1418: issuing a draft must flip the header from "Draft invoice" to the
  // assigned invoice number in place — no manual reload. The editor refetches
  // via onChanged() after the mutation; this guards that wiring end-to-end.
  it('updates the header from "Draft invoice" to the invoice number after Issue, without a reload', async () => {
    let issued = false;
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') {
        issued = true;
        return json({ data: { id: 'inv-1', status: 'sent', invoiceNumber: 'INV-2026-0002' } });
      }
      if (input === '/invoices/inv-1/payments') return json({ data: [] });
      if (input === '/invoices/inv-1') {
        return json({ data: issued
          ? invoice({ status: 'sent', invoiceNumber: 'INV-2026-0002', sentAt: '2026-06-17T00:00:00Z', issueDate: '2026-06-17', dueDate: '2026-07-17' })
          : invoice({}) });
      }
      return json({ data: {} });
    });

    render(<InvoiceWorkspace invoiceId="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-workspace-title')).toHaveTextContent('Draft invoice'));

    fireEvent.click(screen.getByTestId('invoice-issue'));

    await waitFor(() => expect(screen.getByTestId('invoice-workspace-title')).toHaveTextContent('INV-2026-0002'));
    // The draft editor is gone once issued — the read-only detail takes over.
    expect(screen.queryByTestId('invoice-editor')).not.toBeInTheDocument();
  });
});
