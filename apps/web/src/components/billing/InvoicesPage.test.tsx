import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoicesPage from './InvoicesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() (billing-RBAC UI gating) reads grants off the store; grant
  // the admin wildcard so every gated control renders and these tests exercise
  // full functionality.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload), blob: vi.fn() }) as unknown as Response;

const ORGS = [{ id: 'org-1', name: 'Acme Corp' }, { id: 'org-2', name: 'Globex' }];
const INVOICES = [
  {
    id: 'inv-1', invoiceNumber: 'INV-0001', orgId: 'org-1', siteId: null, status: 'overdue',
    currencyCode: 'USD', issueDate: '2026-05-01', dueDate: '2026-05-31', sentAt: null, subtotal: '100.00',
    taxRate: '0.000', taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00',
    billToName: 'Acme', notes: null, createdAt: '2026-05-01T00:00:00Z',
  },
  {
    id: 'inv-2', invoiceNumber: null, orgId: 'org-2', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '0.00',
    taxRate: null, taxTotal: '0.00', total: '0.00', amountPaid: '0.00', balance: '0.00',
    billToName: null, notes: null, createdAt: '2026-06-01T00:00:00Z',
  },
];

function wireDefault() {
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
    if (input.startsWith('/invoices')) return json({ data: INVOICES });
    if (input.startsWith('/orgs/sites')) return json({ data: [] });
    return json({}, false, 404);
  });
}

describe('InvoicesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renders invoice rows with status badge and currency totals', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    const row = screen.getByTestId('invoices-row-inv-1');
    expect(within(row).getByText('INV-0001')).toBeInTheDocument();
    expect(within(row).getByText('Acme Corp')).toBeInTheDocument();
    // Total + balance both render $100.00 in this row.
    expect(within(row).getAllByText('$100.00')).toHaveLength(2);
    // Overdue badge label + restrained overdue cue (red dot indicator + due tone),
    // replacing the old full-row red tint.
    expect(screen.getByTestId('invoices-status-inv-1')).toHaveTextContent('Overdue');
    expect(row.querySelector('.bg-red-500')).not.toBeNull();
  });

  it('writes filter selections to the URL hash', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('invoices-filter-status'), { target: { value: 'overdue' } });
    expect(window.location.hash).toContain('status=overdue');

    fireEvent.change(screen.getByTestId('invoices-filter-org'), { target: { value: 'org-1' } });
    expect(window.location.hash).toContain('orgId=org-1');
  });

  it('navigates to a row on click', async () => {
    wireDefault();
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('invoices-row-inv-1'));
    expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-1');
  });

  it('assembles a draft and navigates to it', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/orgs/organizations')) return json({ data: ORGS });
      if (input.startsWith('/orgs/sites')) return json({ data: [] });
      if (input.includes('/invoices/assemble') && opts?.method === 'POST') {
        return json({ data: { invoice: { id: 'inv-new' }, lines: [] } });
      }
      if (input.startsWith('/invoices')) return json({ data: INVOICES });
      return json({}, false, 404);
    });
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoices-assemble-open'));
    await waitFor(() => expect(screen.getByTestId('invoices-assemble-dialog')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('invoices-assemble-org'), { target: { value: 'org-1' } });
    fireEvent.change(screen.getByTestId('invoices-assemble-from'), { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getByTestId('invoices-assemble-to'), { target: { value: '2026-05-31' } });
    fireEvent.click(screen.getByTestId('invoices-assemble-submit'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-new'));
  });
});
