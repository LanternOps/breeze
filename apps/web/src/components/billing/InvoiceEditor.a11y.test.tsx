// #2151 — every qty/price control in the invoice editor answered to the same
// accessible name ("Quantity" / "Unit price"): the manual add-line row, the
// catalog-pick row, and every persisted line row. A screen reader's
// form-controls list was therefore a run of indistinguishable entries with
// nothing to say which line each one belonged to.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
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
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const namedLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: 'Firewall install', description: 'Setup', quantity: '2.00', unitPrice: '50.00',
  costBasis: null, revenueAllocation: null, taxable: false, customerVisible: true,
  lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1, deviceCount: 0,
};

const detailWith = (lines: InvoiceDetail['lines']): InvoiceDetail => ({
  invoice: {
    id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '100.00', taxRate: null,
    taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
    notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
  },
  lines,
});

describe('InvoiceEditor — line-field accessible names (#2151)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      return json({ data: {} });
    });
  });

  it('names a persisted line’s qty and price inputs after its item', async () => {
    render(<InvoiceEditor detail={detailWith([namedLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-line-qty-line-1')).toHaveAttribute('aria-label', 'Quantity for Firewall install');
    expect(screen.getByTestId('invoice-line-price-line-1')).toHaveAttribute('aria-label', 'Unit price for Firewall install');
  });

  it('falls back to the description, then to "this line", for a line with no name', async () => {
    const described = { ...namedLine, name: null };
    const bare = { ...namedLine, id: 'line-2', name: null, description: null, sortOrder: 2 };
    render(<InvoiceEditor detail={detailWith([described, bare])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-line-qty-line-1')).toHaveAttribute('aria-label', 'Quantity for Setup');
    expect(screen.getByTestId('invoice-line-qty-line-2')).toHaveAttribute('aria-label', 'Quantity for this line');
  });

  it('gives two lines distinct qty/price names rather than N identical "Quantity" controls', async () => {
    const second = { ...namedLine, id: 'line-2', name: 'Switch install', sortOrder: 2 };
    render(<InvoiceEditor detail={detailWith([namedLine, second])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const names = ['invoice-line-qty-line-1', 'invoice-line-qty-line-2', 'invoice-line-price-line-1', 'invoice-line-price-line-2']
      .map((id) => screen.getByTestId(id).getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('names the manual add-line row’s qty/price as the new line, not a duplicate of the rows below', async () => {
    render(<InvoiceEditor detail={detailWith([namedLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-add-mode-manual'));

    expect(screen.getByTestId('invoice-manual-qty')).toHaveAttribute('aria-label', 'New line quantity');
    expect(screen.getByTestId('invoice-manual-price')).toHaveAttribute('aria-label', 'New line unit price');
    expect(screen.getByTestId('invoice-manual-qty').getAttribute('aria-label'))
      .not.toBe(screen.getByTestId('invoice-line-qty-line-1').getAttribute('aria-label'));
  });
});
