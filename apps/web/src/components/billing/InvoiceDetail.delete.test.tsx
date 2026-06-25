import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceDetail from './InvoiceDetail';
import { fetchWithAuth } from '../../stores/auth';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';

// Full set of auth mock (same pattern as InvoiceDetail.permissions.test.tsx)
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
const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const draftDetail: InvoiceDetailData = {
  invoice: {
    id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null,
    subtotal: '0.00', taxRate: null, taxTotal: '0.00', total: '0.00',
    amountPaid: '0.00', balance: '0.00', billToName: 'Acme',
    notes: null, termsAndConditions: null, sellerSnapshot: null,
    createdAt: '2026-06-01T00:00:00Z',
  },
  lines: [],
};

const sentDetail: InvoiceDetailData = {
  ...draftDetail,
  invoice: { ...draftDetail.invoice, status: 'sent', sentAt: '2026-06-02T00:00:00Z' },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'invoices', action: 'write' }];
  // Default: payments endpoint returns empty list; other calls succeed.
  fetchMock.mockImplementation(async (input: string) => {
    if (typeof input === 'string' && input.endsWith('/payments')) return resp({ data: [] });
    return resp({ data: null });
  });
});

describe('InvoiceDetail — delete action', () => {
  it('shows the Delete draft button for a draft invoice when the user has invoices:write', async () => {
    render(<InvoiceDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-delete-open')).toBeInTheDocument();
  });

  it('hides the Delete draft button on a non-draft invoice', async () => {
    render(<InvoiceDetail detail={sentDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-delete-open')).not.toBeInTheDocument();
  });

  it('hides the Delete draft button when the user lacks invoices:write', async () => {
    state.permissions = [{ resource: 'invoices', action: 'read' }];
    render(<InvoiceDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('invoice-delete-open')).not.toBeInTheDocument();
  });

  it('deletes a draft invoice and navigates to the invoices list', async () => {
    const { navigateTo } = await import('@/lib/navigation');
    const navigateMock = vi.mocked(navigateTo);

    render(<InvoiceDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-delete-open'));
    await waitFor(() => expect(screen.getByTestId('invoice-delete-confirm')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-delete-confirm'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/invoices/inv-1', { method: 'DELETE' });
      expect(navigateMock).toHaveBeenCalledWith('/billing/invoices');
    });
  });
});
