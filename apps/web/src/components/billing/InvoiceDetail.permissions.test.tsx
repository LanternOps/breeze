import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceDetail from './InvoiceDetail';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from, so each test can vary the
// invoice permissions the detail view sees. This file exists to cover the
// NEGATIVE gating branches — the sibling InvoiceDetail.test.tsx grants the `*:*`
// wildcard and only ever exercises the visible/true branch, so a mis-wired
// (resource,action) pair (e.g. gating Void on invoices:write instead of
// invoices:send, or the PDF on invoices:send instead of invoices:export) would
// pass there. These tests pin the security-relevant read vs export vs send
// distinction: a read-only or write-only operator must NOT see send/void/
// record-payment/pay-link controls.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const lines: InvoiceDetailData['lines'] = [
  {
    id: 'l1', invoiceId: 'inv-1', sourceType: 'catalog', parentLineId: null, catalogItemId: 'c1',
    description: 'Widget', quantity: '1.00', unitPrice: '120.00', costBasis: '80.00', revenueAllocation: '120.00',
    taxable: true, customerVisible: true, lineTotal: '120.00', isUnapprovedTime: false, sortOrder: 0,
  },
];

// Issued invoice with a balance due and Stripe connected, so that canVoid,
// canRecordPayment and the pay-link branch are all *otherwise* satisfied — the
// only thing keeping the controls hidden is the permission gate under test.
const issued: InvoiceDetailData = {
  invoice: {
    id: 'inv-1', invoiceNumber: 'INV-0007', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-30', sentAt: null, subtotal: '120.00',
    taxRate: '0.000', taxTotal: '0.00', total: '120.00', amountPaid: '0.00', balance: '120.00',
    billToName: 'Acme', notes: null, createdAt: '2026-06-01T00:00:00Z',
  },
  lines,
  stripeConnected: true,
};

const stripePayment = {
  id: 'p1', invoiceId: 'inv-1', amount: '120.00', method: 'bank_transfer' as const, reference: 'ref',
  receivedAt: '2026-06-10', note: null, createdAt: '', source: 'manual' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
  fetchMock.mockImplementation(async (input: string) => {
    if (input.endsWith('/payments')) return json({ data: [stripePayment] });
    return json({ data: {} });
  });
});

describe('InvoiceDetail — permission gating', () => {
  it('read-only (invoices:read) hides export, void, pay-link, payment-void and the record-payment form', async () => {
    state.permissions = [{ resource: 'invoices', action: 'read' }];
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());

    // export gate → Download PDF
    expect(screen.queryByTestId('invoice-download-pdf')).not.toBeInTheDocument();
    // send gate → void, pay-link, manual payment void, record-payment form/submit
    expect(screen.queryByTestId('invoice-void-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-pay-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-void-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-submit')).not.toBeInTheDocument();
  });

  it('invoices:write WITHOUT invoices:send still hides every send-gated control', async () => {
    // The security-relevant case: write is the editing grant, NOT a license to
    // issue/void/take payments. Those all gate on invoices:send.
    state.permissions = [{ resource: 'invoices', action: 'write' }];
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());

    expect(screen.queryByTestId('invoice-void-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-pay-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-void-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-form')).not.toBeInTheDocument();
    // write does not grant export either.
    expect(screen.queryByTestId('invoice-download-pdf')).not.toBeInTheDocument();
  });

  it('invoices:export reveals Download PDF but NOT the send-gated controls', async () => {
    // Proves export and send are independent gates — export must not leak void/
    // pay-link/record-payment.
    state.permissions = [{ resource: 'invoices', action: 'export' }];
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-download-pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-void-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-pay-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-payment-form')).not.toBeInTheDocument();
  });

  it('invoices:send reveals void, pay-link, payment-void and the record-payment form', async () => {
    // Positive control proving the test discriminates: the send-gated controls
    // DO appear once invoices:send is granted.
    state.permissions = [{ resource: 'invoices', action: 'send' }];
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-void-open')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-pay-link')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-payment-void-p1')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-payment-form')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-payment-submit')).toBeInTheDocument();
    // send is not export → still no PDF button.
    expect(screen.queryByTestId('invoice-download-pdf')).not.toBeInTheDocument();
  });

  it('hides the void-dialog submit when invoices:send is absent', async () => {
    // The void dialog renders a confirm button only behind invoices:send; with
    // read-only the dialog markup is not even reachable (the open button is
    // hidden), so the submit must be absent.
    state.permissions = [{ resource: 'invoices', action: 'read' }];
    render(<InvoiceDetail detail={issued} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-void-submit')).not.toBeInTheDocument();
  });
});
