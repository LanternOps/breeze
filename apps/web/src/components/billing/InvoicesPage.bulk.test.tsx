import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock fetchWithAuth — InvoicesPage calls it directly (no listInvoices wrapper).
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

// Mock showToast to suppress UI side-effects.
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// Mock navigateTo to prevent navigation side-effects.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Grant all permissions so all bulk actions appear.
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

import { InvoicesPage } from './InvoicesPage';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const I1 = '11111111-1111-1111-1111-111111111111';
const I2 = '22222222-2222-2222-2222-222222222222';

const INVOICES = [
  { id: I1, orgId: 'o1', status: 'draft', total: '10.00', balance: '10.00', currencyCode: 'USD', issueDate: null, dueDate: null },
  { id: I2, orgId: 'o1', status: 'draft', total: '20.00', balance: '20.00', currencyCode: 'USD', issueDate: null, dueDate: null },
];

function wireDefault() {
  fetchWithAuth.mockImplementation((url: string) => {
    if (String(url).includes('/orgs/organizations')) return Promise.resolve(json({ data: [] }));
    if (String(url).startsWith('/invoices')) return Promise.resolve(json({ data: INVOICES }));
    return Promise.resolve(json({}, 404));
  });
}

describe('InvoicesPage bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireDefault();
  });

  it('selects rows and posts ids to /invoices/bulk-delete', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));
    fireEvent.click(screen.getByTestId(`invoices-select-${I2}`));

    // Wire bulk-delete response and subsequent refetch.
    fetchWithAuth.mockImplementation((url: string) => {
      if (String(url).includes('/bulk-delete'))
        return Promise.resolve(json({ data: { total: 2, succeeded: 2, skipped: 0, failed: 0, skippedReasons: {} } }));
      if (String(url).includes('/orgs/organizations')) return Promise.resolve(json({ data: [] }));
      if (String(url).startsWith('/invoices')) return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({}, 404));
    });

    fireEvent.click(screen.getByTestId('invoices-bulk-action-delete'));

    // Confirm dialog must appear before the request is sent.
    const confirmBtn = await screen.findByTestId('invoices-bulk-delete-confirm');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/invoices/bulk-delete'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string).ids).toEqual([I1, I2]);
    });
  });

  it('opens void dialog, fills reason, and posts to /invoices/bulk-void', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));

    fireEvent.click(screen.getByTestId('invoices-bulk-action-void'));

    // Void dialog should appear.
    await screen.findByTestId('invoices-bulk-void-dialog');

    // Submit is disabled while reason is empty.
    expect(screen.getByTestId('invoices-bulk-void-submit')).toBeDisabled();

    // Fill in reason.
    fireEvent.change(screen.getByTestId('invoices-bulk-void-reason'), {
      target: { value: 'duplicate' },
    });

    // Wire bulk-void response and subsequent refetch.
    fetchWithAuth.mockImplementation((url: string) => {
      if (String(url).includes('/bulk-void'))
        return Promise.resolve(json({ data: { total: 1, succeeded: 1, skipped: 0, failed: 0, skippedReasons: {} } }));
      if (String(url).includes('/orgs/organizations')) return Promise.resolve(json({ data: [] }));
      if (String(url).startsWith('/invoices')) return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({}, 404));
    });

    fireEvent.click(screen.getByTestId('invoices-bulk-void-submit'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/invoices/bulk-void'));
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.ids).toEqual([I1]);
      expect(body.reason).toBe('duplicate');
    });
  });

  it('keeps void dialog open and preserves reason when bulk-void fails', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));
    fireEvent.click(screen.getByTestId('invoices-bulk-action-void'));

    await screen.findByTestId('invoices-bulk-void-dialog');

    const textarea = screen.getByTestId('invoices-bulk-void-reason');
    fireEvent.change(textarea, { target: { value: 'client requested' } });
    expect(screen.getByTestId('invoices-bulk-void-submit')).not.toBeDisabled();

    // Wire bulk-void to return HTTP 500 so runAction throws.
    fetchWithAuth.mockImplementation((url: string) => {
      if (String(url).includes('/bulk-void'))
        return Promise.resolve(json({ error: 'Internal server error' }, 500));
      if (String(url).includes('/orgs/organizations')) return Promise.resolve(json({ data: [] }));
      if (String(url).startsWith('/invoices')) return Promise.resolve(json({ data: INVOICES }));
      return Promise.resolve(json({}, 404));
    });

    fireEvent.click(screen.getByTestId('invoices-bulk-void-submit'));

    // Dialog must remain open and reason must be preserved.
    await waitFor(() => {
      expect(screen.getByTestId('invoices-bulk-void-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('invoices-bulk-void-reason')).toHaveValue('client requested');
    });

    // Clearing the reason re-disables the submit button.
    fireEvent.change(screen.getByTestId('invoices-bulk-void-reason'), { target: { value: '' } });
    expect(screen.getByTestId('invoices-bulk-void-submit')).toBeDisabled();
  });
});
