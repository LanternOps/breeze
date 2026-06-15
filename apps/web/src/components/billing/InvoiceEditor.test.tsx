import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function draft(lines: InvoiceDetail['lines']): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', amountPaid: '0.00', balance: '0.00', billToName: 'Acme',
      notes: '', createdAt: '2026-06-01T00:00:00Z',
    },
    lines,
  };
}

const manualLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
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

  it('disables Issue when there are no customer-visible lines', async () => {
    render(<InvoiceEditor detail={draft([])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-issue')).toBeDisabled();
    expect(screen.getByTestId('invoice-issue-send')).toBeDisabled();
    expect(screen.getByTestId('invoice-no-visible-hint')).toBeInTheDocument();
  });

  it('enables Issue when a visible line exists and shows the total', async () => {
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-issue')).not.toBeDisabled();
    expect(screen.getByTestId('invoice-line-line-1')).toHaveTextContent('Consulting');
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

  it('flags unapproved-time lines with a warning banner', async () => {
    const unapproved = { ...manualLine, id: 'line-u', isUnapprovedTime: true };
    render(<InvoiceEditor detail={draft([unapproved])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-unapproved-warning')).toBeInTheDocument());
  });

  it('Issue & Send shows a success toast when the email was dispatched (emailed:true)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/send' && opts?.method === 'POST') return json({ data: { invoice: { id: 'inv-1', status: 'sent' }, emailed: true } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-issue-send'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Invoice issued and sent' }));
  });

  it('Issue & Send shows a WARNING toast (not error) when nothing was emailed (emailed:false)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/send' && opts?.method === 'POST') return json({ data: { invoice: { id: 'inv-1', status: 'sent' }, emailed: false, reason: 'no_billing_contact' } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-issue-send'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    // never a success "sent" claim when nothing went out
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Invoice issued and sent' }));
  });
});
