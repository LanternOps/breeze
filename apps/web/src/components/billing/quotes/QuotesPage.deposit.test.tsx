import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuotesPage from './QuotesPage';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload), blob: vi.fn() }) as unknown as Response;

const ORGS = [{ id: 'org-1', name: 'Acme Corp' }];
function quote(extra: Record<string, unknown>) {
  return {
    id: 'q', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null, taxTotal: '0.00',
    total: '150.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
    depositType: 'none', billToName: null, introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
    acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    invoiceDepositDue: null, invoiceAmountPaid: null, ...extra,
  };
}

function wire(quotes: unknown[]) {
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
    if (input.startsWith('/quotes')) return json({ data: quotes });
    return json({}, false, 404);
  });
}

describe('QuotesPage deposit badge', () => {
  beforeEach(() => { vi.clearAllMocks(); window.location.hash = ''; });

  it('shows no badge for a quote without a deposit', async () => {
    wire([quote({ id: 'qn', depositType: 'none' })]);
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-row-qn')).toBeInTheDocument());
    expect(screen.queryByTestId('quotes-deposit-badge-qn')).not.toBeInTheDocument();
  });

  it('shows a neutral Deposit chip for a draft with a deposit configured', async () => {
    wire([quote({ id: 'qd', depositType: 'percent' })]);
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-deposit-badge-qd')).toHaveTextContent('Deposit'));
    expect(screen.getByTestId('quotes-deposit-badge-qd')).not.toHaveTextContent('paid');
  });

  it('shows Deposit unpaid / paid for converted quotes per the invoice money state', async () => {
    wire([
      quote({ id: 'qu', status: 'converted', depositType: 'percent', convertedInvoiceId: 'i1', invoiceDepositDue: '300.00', invoiceAmountPaid: '0.00' }),
      quote({ id: 'qp', status: 'converted', depositType: 'percent', convertedInvoiceId: 'i2', invoiceDepositDue: '300.00', invoiceAmountPaid: '300.00' }),
    ]);
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-deposit-badge-qu')).toHaveTextContent('Deposit unpaid'));
    expect(screen.getByTestId('quotes-deposit-badge-qp')).toHaveTextContent('Deposit paid');
  });
});
