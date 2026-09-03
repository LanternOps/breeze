import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceDetail from './InvoiceDetail';
import { fetchWithAuth } from '../../stores/auth';
import type { InvoiceDetail as InvoiceDetailData, InvoiceStatus } from './invoiceTypes';

// #4416 — the draft-only atomic change-currency op (#3774,
// changeInvoiceCurrency in invoiceService.ts) has been reachable server-side
// since multi-currency wave 2, but only ContractDetail ever grew a dialog for
// it. These tests pin the ported behaviour:
//   - the action is offered only on a DRAFT invoice, gated on invoices:write;
//   - a success posts exactly the confirmed payload and reloads the invoice;
//   - a 409 CURRENCY_LOCKED renders inline (in ADDITION to runAction's own
//     toast) and keeps the dialog open — never a silent no-op.

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function detail(status: InvoiceStatus, currencyCode = 'USD'): InvoiceDetailData {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status,
      currencyCode, issueDate: null, dueDate: null, sentAt: null,
      subtotal: '0.00', taxRate: null, taxTotal: '0.00', total: '0.00',
      amountPaid: '0.00', balance: '0.00', billToName: 'Acme',
      notes: null, termsAndConditions: null, sellerSnapshot: null,
      createdAt: '2026-06-01T00:00:00Z',
    },
    lines: [],
  };
}

async function openDialog() {
  await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('invoice-currency-open'));
  await screen.findByTestId('invoice-currency-dialog');
}

async function confirmWith(mode: 'clear' | 'reprice', currency = 'EUR') {
  fireEvent.change(screen.getByTestId('invoice-currency-select'), { target: { value: currency } });
  fireEvent.click(screen.getByTestId(`invoice-currency-mode-${mode}`));
  fireEvent.click(screen.getByTestId('invoice-currency-confirm-check'));
  fireEvent.click(screen.getByTestId('invoice-currency-submit'));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'invoices', action: 'write' }];
  // Default: payments endpoint returns empty list; the currency op succeeds.
  fetchMock.mockImplementation(async (input: string) => {
    if (typeof input === 'string' && input.endsWith('/payments')) return resp({ data: [] });
    if (typeof input === 'string' && input.endsWith('/currency')) return resp({ data: { id: 'inv-1' } });
    return resp({ data: null });
  });
});

describe('InvoiceDetail — draft currency change (#4416)', () => {
  it('shows the action on a DRAFT invoice with invoices:write', async () => {
    render(<InvoiceDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-currency-open')).toBeInTheDocument();
  });

  it('hides the action without invoices:write', async () => {
    state.permissions = [{ resource: 'invoices', action: 'read' }];
    render(<InvoiceDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-currency-open')).not.toBeInTheDocument();
  });

  it('does not offer the action on a non-draft (sent) invoice', async () => {
    render(<InvoiceDetail detail={detail('sent')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-currency-open')).not.toBeInTheDocument();
  });

  it('keeps submit disabled until a mode is chosen, confirmed, and the currency differs', async () => {
    render(<InvoiceDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    const submit = () => screen.getByTestId('invoice-currency-submit') as HTMLButtonElement;

    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('invoice-currency-select'), { target: { value: 'EUR' } });
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('invoice-currency-mode-clear'));
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('invoice-currency-confirm-check'));
    expect(submit().disabled).toBe(false);

    fireEvent.change(screen.getByTestId('invoice-currency-select'), { target: { value: 'USD' } });
    expect(submit().disabled).toBe(true);
  });

  it('posts exactly the confirmed payload and reloads the invoice on success', async () => {
    const onChanged = vi.fn();
    render(<InvoiceDetail detail={detail('draft')} onChanged={onChanged} />);
    await openDialog();
    await confirmWith('reprice', 'EUR');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/invoices/inv-1/currency', {
      method: 'POST', body: JSON.stringify({ currencyCode: 'EUR', reprice: true }),
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('invoice-currency-dialog')).not.toBeInTheDocument());
  });

  it('sends clearLines (not reprice) when the operator chooses to clear the lines', async () => {
    render(<InvoiceDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    await confirmWith('clear', 'JPY');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/invoices/inv-1/currency', {
      method: 'POST', body: JSON.stringify({ currencyCode: 'JPY', clearLines: true }),
    }));
  });

  it('shows a 409 CURRENCY_LOCKED message inline and keeps the dialog open', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (typeof input === 'string' && input.endsWith('/payments')) return resp({ data: [] });
      if (typeof input === 'string' && input.endsWith('/currency')) {
        return resp({
          error: 'Invoice has 2 line(s) priced in USD — pass clearLines to remove them, or delete the draft',
          code: 'CURRENCY_LOCKED',
        }, 409);
      }
      return resp({ data: null });
    });

    const onChanged = vi.fn();
    render(<InvoiceDetail detail={detail('draft')} onChanged={onChanged} />);
    await openDialog();
    await confirmWith('clear');

    const error = await screen.findByTestId('invoice-currency-error');
    expect(error).toHaveTextContent(/pass clearLines/i);
    expect(screen.getByTestId('invoice-currency-dialog')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('clears a previous inline error when the operator retries', async () => {
    let first = true;
    fetchMock.mockImplementation(async (input: string) => {
      if (typeof input === 'string' && input.endsWith('/payments')) return resp({ data: [] });
      if (typeof input === 'string' && input.endsWith('/currency')) {
        if (first) { first = false; return resp({ error: 'locked', code: 'CURRENCY_LOCKED' }, 409); }
        return resp({ data: { id: 'inv-1' } });
      }
      return resp({ data: null });
    });

    render(<InvoiceDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    await confirmWith('clear');
    await screen.findByTestId('invoice-currency-error');

    fireEvent.click(screen.getByTestId('invoice-currency-submit'));
    await waitFor(() => expect(screen.queryByTestId('invoice-currency-dialog')).not.toBeInTheDocument());
  });
});
