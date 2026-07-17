import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoicesPage from './InvoicesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
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
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload), blob: vi.fn() }) as unknown as Response;

const ORGS = [{ id: 'org-1', name: 'Acme Corp' }];
function invoice(extra: Record<string, unknown>) {
  return {
    id: 'inv', invoiceNumber: 'INV-1', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-05-01', dueDate: '2026-05-31', sentAt: null, subtotal: '1000.00',
    taxRate: '0.000', taxTotal: '0.00', total: '1000.00', amountPaid: '0.00', balance: '1000.00',
    depositDue: null, billToName: 'Acme', notes: null, termsAndConditions: null, sellerSnapshot: null,
    createdAt: '2026-05-01T00:00:00Z', ...extra,
  };
}

function wire(invoices: unknown[]) {
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
    if (input.startsWith('/invoices')) return json({ data: invoices });
    if (input.startsWith('/orgs/sites')) return json({ data: [] });
    return json({}, false, 404);
  });
}

describe('InvoicesPage deposit badge', () => {
  beforeEach(() => { vi.clearAllMocks(); window.location.hash = ''; });

  it('shows no deposit badge when the invoice has no deposit', async () => {
    wire([invoice({ id: 'nd', depositDue: null })]);
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-row-nd')).toBeInTheDocument());
    expect(screen.queryByTestId('invoices-deposit-unpaid-nd')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoices-deposit-paid-nd')).not.toBeInTheDocument();
  });

  it('shows Deposit unpaid while the deposit is unmet and Deposit paid once met', async () => {
    wire([
      invoice({ id: 'du', depositDue: '300.00', amountPaid: '0.00', balance: '1000.00' }),
      invoice({ id: 'dp', depositDue: '300.00', amountPaid: '300.00', balance: '700.00', status: 'partially_paid' }),
    ]);
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-deposit-unpaid-du')).toBeInTheDocument());
    expect(screen.getByTestId('invoices-deposit-paid-dp')).toBeInTheDocument();
  });
});
