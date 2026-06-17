import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuotesPage from './QuotesPage';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload), blob: vi.fn() }) as unknown as Response;

const ORGS = [{ id: 'org-1', name: 'Acme Corp' }];
const QUOTES = [
  {
    id: 'q-1', quoteNumber: 'Q-0001', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null, taxTotal: '0.00',
    total: '150.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '50.00', annualRecurringTotal: '0.00',
    billToName: null, introNotes: null, terms: null, acceptedAt: null, declinedAt: null, convertedAt: null,
    convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
];

describe('QuotesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renders the empty state without crashing', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: [] });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-empty')).toBeInTheDocument());
    expect(screen.getByText('No quotes yet')).toBeInTheDocument();
  });

  it('renders quote rows with status badge and currency total', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/quotes')) return json({ data: QUOTES });
      return json({}, false, 404);
    });
    render(<QuotesPage />);
    await waitFor(() => expect(screen.getByTestId('quotes-table')).toBeInTheDocument());

    const row = screen.getByTestId('quotes-row-q-1');
    expect(within(row).getByText('Q-0001')).toBeInTheDocument();
    expect(within(row).getByText('Acme Corp')).toBeInTheDocument();
    expect(within(row).getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByTestId('quotes-status-q-1')).toHaveTextContent('Draft');
  });
});
