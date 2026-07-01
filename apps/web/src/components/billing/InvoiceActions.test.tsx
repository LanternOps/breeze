import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceActions from './InvoiceActions';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from. This file owns BOTH the
// behavior tests (issue / issue & send / delete flows, moved here from
// InvoiceEditor.test / InvoiceDetail.delete.test when the actions were extracted
// into InvoiceActions) and the permission gating for the extracted buttons.
const state = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const visibleLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: null, description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

function detail(lines: InvoiceDetail['lines'], extra: Partial<InvoiceDetail['invoice']> = {}): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '100.00', taxRate: null,
      taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
      ...extra,
    },
    lines,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: '*', action: '*' }];
  fetchMock.mockImplementation(async () => json({ data: {} }));
});

describe('InvoiceActions — issue flows', () => {
  it('disables Issue / Issue & Send when there are no customer-visible lines, with a visible hint', () => {
    render(<InvoiceActions detail={detail([])} variant="header" />);
    expect(screen.getByTestId('invoice-issue')).toBeDisabled();
    expect(screen.getByTestId('invoice-issue-send')).toBeDisabled();
    expect(screen.getByTestId('invoice-no-visible-hint')).toBeInTheDocument();
    // The hint is wired to the disabled buttons for AT.
    expect(screen.getByTestId('invoice-issue')).toHaveAttribute('aria-describedby', 'invoice-no-visible-hint-header');
  });

  it('enables Issue when a customer-visible line exists (no hint)', () => {
    render(<InvoiceActions detail={detail([visibleLine])} variant="header" />);
    expect(screen.getByTestId('invoice-issue')).not.toBeDisabled();
    expect(screen.queryByTestId('invoice-no-visible-hint')).not.toBeInTheDocument();
  });

  it('plain Issue POSTs /issue directly (no confirm) and triggers onChanged', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail([visibleLine])} onChanged={onChanged} variant="header" />);
    fireEvent.click(screen.getByTestId('invoice-issue'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/invoices/inv-1/issue', { method: 'POST' });
    // Plain Issue never hits /send.
    expect(fetchMock.mock.calls.find((c) => c[0] === '/invoices/inv-1/send')).toBeUndefined();
  });

  it('Issue & Send shows a success toast when the email was dispatched (emailed:true)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/send' && opts?.method === 'POST') return json({ data: { invoice: { id: 'inv-1', status: 'sent' }, emailed: true } });
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail([visibleLine])} onChanged={onChanged} variant="header" />);

    fireEvent.click(screen.getByTestId('invoice-issue-send'));
    fireEvent.click(await screen.findByTestId('invoice-issue-send-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Invoice issued and sent' }));
  });

  it('Issue & Send shows a WARNING toast (not error) when nothing was emailed (emailed:false)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/send' && opts?.method === 'POST') return json({ data: { invoice: { id: 'inv-1', status: 'sent' }, emailed: false, reason: 'no_billing_contact' } });
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail([visibleLine])} onChanged={onChanged} variant="header" />);

    fireEvent.click(screen.getByTestId('invoice-issue-send'));
    fireEvent.click(await screen.findByTestId('invoice-issue-send-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    // never a success "sent" claim when nothing went out
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Invoice issued and sent' }));
  });

  it('shows an "Issuing…" label on the Issue button while the mutation is in flight (#1418)', async () => {
    let resolveIssue: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') {
        return new Promise<Response>((res) => { resolveIssue = res; });
      }
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail([visibleLine])} onChanged={vi.fn()} variant="header" />);

    fireEvent.click(screen.getByTestId('invoice-issue'));

    // In flight: button is disabled AND relabelled so it never reads as a stuck "Issue".
    await waitFor(() => expect(screen.getByTestId('invoice-issue')).toHaveTextContent('Issuing…'));
    expect(screen.getByTestId('invoice-issue')).toBeDisabled();

    resolveIssue(json({ data: { id: 'inv-1', status: 'sent' } }));
    await waitFor(() => expect(screen.getByTestId('invoice-issue')).toHaveTextContent('Issue'));
  });

  it('hides Issue / Issue & Send on a non-draft invoice', () => {
    render(<InvoiceActions detail={detail([visibleLine], { status: 'sent', invoiceNumber: 'INV-1', sentAt: '2026-06-02T00:00:00Z' })} variant="header" />);
    expect(screen.queryByTestId('invoice-issue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-issue-send')).not.toBeInTheDocument();
    // PDF stays reachable on an issued invoice.
    expect(screen.getByTestId('invoice-download-pdf')).toBeInTheDocument();
  });
});

describe('InvoiceActions — delete flow', () => {
  it('deletes a draft invoice through the confirm dialog and navigates to the invoices list', async () => {
    const { navigateTo } = await import('@/lib/navigation');
    const navigateMock = vi.mocked(navigateTo);

    render(<InvoiceActions detail={detail([])} variant="rail" />);

    fireEvent.click(screen.getByTestId('invoice-delete-open'));
    await waitFor(() => expect(screen.getByTestId('invoice-delete-confirm')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-delete-confirm'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/invoices/inv-1', { method: 'DELETE' });
      expect(navigateMock).toHaveBeenCalledWith('/billing/invoices');
    });
  });

  it('hides Delete draft on a non-draft invoice', () => {
    render(<InvoiceActions detail={detail([visibleLine], { status: 'sent', sentAt: '2026-06-02T00:00:00Z' })} variant="rail" />);
    expect(screen.queryByTestId('invoice-delete-open')).not.toBeInTheDocument();
  });
});

describe('InvoiceActions — permission gating', () => {
  it('invoices:write only — Delete renders, Issue / Issue & Send / PDF stay hidden', () => {
    // write builds and can discard the draft; issuing/sending is a separate grant
    // (invoices:send), export another (invoices:export).
    state.permissions = [{ resource: 'invoices', action: 'write' }];
    render(<InvoiceActions detail={detail([visibleLine])} variant="header" />);
    expect(screen.getByTestId('invoice-delete-open')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-issue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-issue-send')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-download-pdf')).not.toBeInTheDocument();
  });

  it('invoices:send only — Issue / Issue & Send render, Delete / PDF stay hidden', () => {
    state.permissions = [{ resource: 'invoices', action: 'send' }];
    render(<InvoiceActions detail={detail([visibleLine])} variant="header" />);
    expect(screen.getByTestId('invoice-issue')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-issue-send')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-delete-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-download-pdf')).not.toBeInTheDocument();
  });

  it('invoices:export only — Download PDF renders, Issue / Delete stay hidden', () => {
    state.permissions = [{ resource: 'invoices', action: 'export' }];
    render(<InvoiceActions detail={detail([visibleLine])} variant="header" />);
    expect(screen.getByTestId('invoice-download-pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-issue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-delete-open')).not.toBeInTheDocument();
  });

  it('renders nothing at all (no empty container) for a read-only viewer', () => {
    state.permissions = [{ resource: 'invoices', action: 'read' }];
    render(<InvoiceActions detail={detail([visibleLine])} variant="header" />);
    expect(screen.queryByTestId('invoice-actions-header')).not.toBeInTheDocument();
  });
});
