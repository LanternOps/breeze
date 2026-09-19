import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock fetchWithAuth — InvoicesPage calls it directly (no listInvoices wrapper).
const fetchWithAuth = vi.fn();

interface MockAuthState {
  user: { permissions: { resource: string; action: string }[] };
  tokens: { accessToken: string } | null;
}

// Mutable so a test can hand the page an access token whose claims decide
// whether the partner-only QuickBooks bulk push is offered. `null` reproduces a
// cold load, where the scope is *unresolved* rather than denied (#4010).
let authTokens: MockAuthState['tokens'] = null;
const authState = (): MockAuthState => ({
  user: { permissions: [{ resource: '*', action: '*' }] },
  tokens: authTokens,
});

vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign((selector: (s: MockAuthState) => unknown) => selector(authState()), {
    getState: () => authState(),
  }),
}));

/** Unsigned JWT whose payload carries just the scope claim (decode is base64url only). */
const tokenForScope = (scope: 'partner' | 'organization' | 'system') =>
  `h.${btoa(JSON.stringify({ scope })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

// Mock showToast to suppress UI side-effects.
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// Mock navigateTo to prevent navigation side-effects.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Grant all permissions so all bulk actions appear. Mutable so a single test
// can drop `invoices:write` and prove the QuickBooks bulk push is gated on it.
let canFn: (resource: string, action: string) => boolean = () => true;
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: (r: string, a: string) => canFn(r, a) }),
}));

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

/** Wires the push-bulk route to `body`, leaving the list/org fetches intact. */
function wirePushBulk(body: unknown) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (String(url).includes('/accounting/quickbooks/invoices/push-bulk')) return Promise.resolve(json(body));
    if (String(url).includes('/orgs/organizations')) return Promise.resolve(json({ data: [] }));
    if (String(url).startsWith('/invoices')) return Promise.resolve(json({ data: INVOICES }));
    return Promise.resolve(json({}, 404));
  });
}

describe('InvoicesPage bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canFn = () => true;
    authTokens = null;
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

  it('bulk "Push to QuickBooks" posts the selected ids and reports enqueued/skipped', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    // Hidden until something is selected (BulkActionBar only renders with a count).
    expect(screen.queryByTestId('invoices-bulk-action-quickbooks')).toBeNull();

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));
    fireEvent.click(screen.getByTestId(`invoices-select-${I2}`));

    fetchWithAuth.mockImplementation((url: string) => {
      if (String(url).includes('/accounting/quickbooks/invoices/push-bulk'))
        return Promise.resolve(json({ enqueued: 1, skipped: 1 }));
      if (String(url).includes('/orgs/organizations')) return Promise.resolve(json({ data: [] }));
      if (String(url).startsWith('/invoices')) return Promise.resolve(json({ data: INVOICES }));
      return Promise.resolve(json({}, 404));
    });

    fireEvent.click(screen.getByTestId('invoices-bulk-action-quickbooks'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) =>
        String(c[0]).includes('/accounting/quickbooks/invoices/push-bulk'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string).invoiceIds).toEqual([I1, I2]);
    });

    // The route answers a bare `{ enqueued, skipped }` (no `data` envelope) —
    // both counts must reach the operator, not just the happy half.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('1 skipped') }),
      ));

    // Selection clears so the bar collapses, same as every other bulk action.
    await waitFor(() => expect(screen.queryByTestId('invoices-bulk-action-quickbooks')).toBeNull());
  });

  it('hides the QuickBooks bulk push without invoices:write', async () => {
    canFn = (resource, action) => !(resource === 'invoices' && action === 'write');
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));

    expect(screen.queryByTestId('invoices-bulk-action-quickbooks')).toBeNull();
    // Control: a non-write action is still offered, so the assertion above is
    // about the permission, not about the bar failing to render at all.
    expect(screen.getByTestId('invoices-bulk-action-issue')).toBeInTheDocument();
  });

  it('surfaces enqueued, skipped AND failed when some enqueues fail', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));
    fireEvent.click(screen.getByTestId(`invoices-select-${I2}`));

    // `failed` counts invoices whose enqueue threw (Redis outage). Reporting
    // them as queued would promise a push that will never happen.
    wirePushBulk({ enqueued: 3, skipped: 1, failed: 2 });

    fireEvent.click(screen.getByTestId('invoices-bulk-action-quickbooks'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          message: expect.stringMatching(/3 queued for QuickBooks.*\b1 skipped\b.*\b2 failed\b/),
        }),
      ));
    // A failure count must never be lost behind the skipped-only wording.
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: '3 queued for QuickBooks, 1 skipped' }),
    );
  });

  it('keeps the skipped-only warning when nothing failed to queue', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));
    fireEvent.click(screen.getByTestId(`invoices-select-${I2}`));

    wirePushBulk({ enqueued: 1, skipped: 2, failed: 0 });

    fireEvent.click(screen.getByTestId('invoices-bulk-action-quickbooks'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        type: 'warning',
        message: '1 queued for QuickBooks, 2 skipped',
      }));
  });

  it('treats an absent failed count as zero rather than rendering undefined', async () => {
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));

    // Older/unexpected body shape: no `failed` key at all.
    wirePushBulk({ enqueued: 1, skipped: 0 });

    fireEvent.click(screen.getByTestId('invoices-bulk-action-quickbooks'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({ type: 'success', message: '1 queued for QuickBooks' }));
  });

  it('hides the QuickBooks bulk push for an organization-scoped session', async () => {
    // The API gates push-bulk on partner scope, so an org token can only 403.
    authTokens = { accessToken: tokenForScope('organization') };
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));

    expect(screen.queryByTestId('invoices-bulk-action-quickbooks')).toBeNull();
    // Control: the other `invoices:write` action is still offered, so this is
    // about the scope, not about the bar failing to render at all.
    expect(screen.getByTestId('invoices-bulk-action-delete')).toBeInTheDocument();
  });

  it('offers the QuickBooks bulk push for a partner-scoped session', async () => {
    authTokens = { accessToken: tokenForScope('partner') };
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));

    expect(screen.getByTestId('invoices-bulk-action-quickbooks')).toBeInTheDocument();
  });

  it('does not hide the QuickBooks bulk push while the scope is unresolved', async () => {
    // No access token yet (cold load / rate-limited refresh): unknown is not
    // denied — fall through to the server rather than hiding the action.
    authTokens = null;
    render(<InvoicesPage />);
    await screen.findByTestId(`invoices-row-${I1}`);

    fireEvent.click(screen.getByTestId(`invoices-select-${I1}`));

    expect(screen.getByTestId('invoices-bulk-action-quickbooks')).toBeInTheDocument();
  });
});
