import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
// The embedded access-request list fetches on mount; answer it separately so the
// per-test mockResolvedValueOnce sequences below only describe portal-users calls.
let requestsHandler: (url: string, init?: RequestInit) => Promise<unknown> = async () => ({
  ok: true, status: 200, json: async () => ({ data: [], hasMore: false }),
});
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: any[]) =>
    String(a[0]).includes('/portal-access-requests') ? requestsHandler(a[0], a[1]) : fetchWithAuth(...a),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// runAction surfaces success/warning/error toasts via showToast from ../shared/Toast.
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

import OrgPortalUsersEditor from './OrgPortalUsersEditor';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => (data) });

beforeEach(() => {
  vi.clearAllMocks();
  requestsHandler = async () => ({ ok: true, status: 200, json: async () => ({ data: [], hasMore: false }) });
});

describe('OrgPortalUsersEditor', () => {
  it('badges show identity providers and no browser access', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [
      { id: 'pu-1', email: 'a@acme.example', name: 'A', status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null, browserAccess: 'none', identityProviders: ['entra', 'google'] },
      { id: 'pu-2', email: 'b@acme.example', name: null, status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null, browserAccess: 'granted', identityProviders: [] }
    ] }));
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByTestId('portal-user-badge-entra-pu-1')).toHaveTextContent('Microsoft sign-in'));
    expect(screen.getByTestId('portal-user-badge-google-pu-1')).toHaveTextContent('Google sign-in');
    expect(screen.getByTestId('portal-user-badge-no-browser-pu-1')).toHaveTextContent('No browser access');
    expect(screen.queryByTestId('portal-user-badge-no-browser-pu-2')).toBeNull();
    expect(screen.queryByTestId('portal-user-badge-entra-pu-2')).toBeNull();
  });

  // W4 (#11381): MSP grants browser access to an add-in account (no epoch bump server-side).
  it('grant browser access calls the route and reloads', async () => {
    const addin = { id: 'pu-1', email: 'a@acme.example', name: 'A', status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null, browserAccess: 'none', identityProviders: ['entra'] };
    const browser = { id: 'pu-2', email: 'b@acme.example', name: null, status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null, browserAccess: 'granted', identityProviders: [] };
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: [addin, browser] }))
      .mockResolvedValueOnce(ok({ data: { browserAccess: 'granted' } }))
      .mockResolvedValueOnce(ok({ data: [{ ...addin, browserAccess: 'granted' }, browser] }));
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    const grant = await screen.findByTestId('portal-user-grant-browser-pu-1');
    expect(grant).toHaveTextContent('Give browser access');
    expect(screen.queryByTestId('portal-user-grant-browser-pu-2')).toBeNull();
    fireEvent.click(grant);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(3));
    expect(fetchWithAuth.mock.calls[1][0]).toBe(`/orgs/organizations/${ORG_ID}/portal-users/pu-1/browser-access`);
    expect(fetchWithAuth.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Browser access granted' }));
    await waitFor(() => expect(screen.queryByTestId('portal-user-grant-browser-pu-1')).toBeNull());
  });

  it('a failed browser-access grant toasts an error, skips the reload and leaves the action available', async () => {
    const addin = { id: 'pu-1', email: 'a@acme.example', name: 'A', status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null, browserAccess: 'none', identityProviders: ['entra'] };
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: [addin] }))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Portal account is disabled', code: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' }) });
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    fireEvent.click(await screen.findByTestId('portal-user-grant-browser-pu-1'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2); // no reload after the failure
    await waitFor(() => expect(screen.getByTestId('portal-user-grant-browser-pu-1')).not.toBeDisabled());
  });

  it('an approval reloads the users table without unmounting the request list', async () => {
    let users = [] as unknown[];
    let pending = [{ id: 'r1', email: 'new@acme.example', name: null, source: 'self', status: 'pending', requestedAt: '2026-11-01T00:00:00Z', lastRequestedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', decidedAt: null, decidedBy: null, portalUserId: null, accountExists: false }];
    requestsHandler = async (url: string) => {
      if (url.endsWith('/r1/approve')) {
        pending = [];
        users = [{ id: 'pu-9', email: 'new@acme.example', name: null, status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null }];
        return ok({ data: { outcome: 'account_created', portalUserId: 'pu-9' } });
      }
      return ok({ data: pending, hasMore: false });
    };
    fetchWithAuth.mockImplementation(async () => ok({ data: users }));
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    fireEvent.click(await screen.findByTestId('portal-access-request-approve-r1'));
    await waitFor(() => expect(screen.getByTestId('portal-user-row-pu-9')).toBeInTheDocument());
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('a failed silent users reload after an approval keeps the table and request list and toasts an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const existing = { id: 'pu-1', email: 'a@acme.example', name: 'A', status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null };
    let usersCalls = 0;
    const pending = [{ id: 'r1', email: 'new@acme.example', name: null, source: 'self', status: 'pending', requestedAt: '2026-11-01T00:00:00Z', lastRequestedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', decidedAt: null, decidedBy: null, portalUserId: null, accountExists: false }];
    requestsHandler = async (url: string) => {
      if (url.endsWith('/r1/approve')) return ok({ data: { outcome: 'account_created', portalUserId: 'pu-9' } });
      return ok({ data: pending, hasMore: false });
    };
    fetchWithAuth.mockImplementation(async () => {
      usersCalls += 1;
      return usersCalls === 1 ? ok({ data: [existing] }) : { ok: false, status: 500, json: async () => ({}) };
    });
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await screen.findByTestId('portal-user-row-pu-1');
    fireEvent.click(await screen.findByTestId('portal-access-request-approve-r1'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Portal users failed to load.' }));
    expect(usersCalls).toBe(2);
    expect(screen.queryByTestId('portal-users-load-error')).toBeNull();
    expect(screen.getByTestId('portal-user-row-pu-1')).toBeInTheDocument();
    expect(screen.getByTestId('portal-access-request-approve-r1')).toBeInTheDocument();
    warn.mockRestore();
  });

  it('renders portal users with status badges', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ data: [
      { id: 'pu-1', email: 'a@acme.example', name: 'A', status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null },
      { id: 'pu-2', email: 'b@acme.example', name: null, status: 'active', effectiveStatus: 'pending_setup', lastLoginAt: null, invitedAt: null }
    ] }));
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByText('a@acme.example')).toBeInTheDocument());
    expect(screen.getByText('b@acme.example')).toBeInTheDocument();
    expect(screen.getByText(/pending setup/i)).toBeInTheDocument();
  });

  it('shows Reactivate (not Resend) for a disabled row, and Resend only for pending_setup', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ data: [
      { id: 'pu-1', email: 'disabled@acme.example', name: 'D', status: 'disabled', effectiveStatus: 'disabled', lastLoginAt: null, invitedAt: null },
      { id: 'pu-2', email: 'pending@acme.example', name: null, status: 'invited', effectiveStatus: 'pending_setup', lastLoginAt: null, invitedAt: null }
    ] }));
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByText('disabled@acme.example')).toBeInTheDocument());

    expect(screen.getByTestId('portal-user-enable-pu-1')).toBeInTheDocument();
    expect(screen.queryByTestId('portal-user-resend-pu-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('portal-user-resend-pu-2')).toBeInTheDocument();
  });

  it('invites a user through the API', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: [] }))                                  // initial list
      .mockResolvedValueOnce(ok({ data: { id: 'pu-new', status: 'invited' }, emailSent: true })) // invite
      .mockResolvedValueOnce(ok({ data: [] }));                                 // reload
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('portal-users-invite-open'));
    fireEvent.change(screen.getByTestId('portal-users-invite-email'), { target: { value: 'new@acme.example' } });
    fireEvent.click(screen.getByTestId('portal-users-invite-submit'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG_ID}/portal-users/invite`,
      expect.objectContaining({ method: 'POST' })
    ));
  });

  it('warns when the invite could not link a contact because several contacts share the address', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: [] }))                                                                          // initial list
      .mockResolvedValueOnce(ok({ data: { id: 'pu-new', email: 'new@acme.example', status: 'invited', contactLink: 'ambiguous' }, emailSent: true })) // invite
      .mockResolvedValueOnce(ok({ data: [] }));                                                                         // reload
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('portal-users-invite-open'));
    fireEvent.change(screen.getByTestId('portal-users-invite-email'), { target: { value: 'new@acme.example' } });
    fireEvent.click(screen.getByTestId('portal-users-invite-submit'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('not see tickets') })
    ));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it.each(['created', 'linked'] as const)(
    'does not warn when the invite contactLink is %s',
    async (contactLink) => {
      fetchWithAuth
        .mockResolvedValueOnce(ok({ data: [] }))
        .mockResolvedValueOnce(ok({ data: { id: 'pu-new', email: 'new@acme.example', status: 'invited', contactLink }, emailSent: true }))
        .mockResolvedValueOnce(ok({ data: [] }));
      render(<OrgPortalUsersEditor orgId={ORG_ID} />);
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByTestId('portal-users-invite-open'));
      fireEvent.change(screen.getByTestId('portal-users-invite-email'), { target: { value: 'new@acme.example' } });
      fireEvent.click(screen.getByTestId('portal-users-invite-submit'));

      await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
      expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    }
  );

  // sweep 2026-09-08 G5-4
  it('warns instead of claiming success when the API reports emailSent: false', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: [] }))                                                                          // initial list
      .mockResolvedValueOnce(ok({ data: { id: 'pu-new', email: 'new@acme.example', status: 'invited' }, emailSent: false })) // invite
      .mockResolvedValueOnce(ok({ data: [] }));                                                                         // reload
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('portal-users-invite-open'));
    fireEvent.change(screen.getByTestId('portal-users-invite-email'), { target: { value: 'new@acme.example' } });
    fireEvent.click(screen.getByTestId('portal-users-invite-submit'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('could not be sent') })
    ));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('guards the invite email client-side: invalid disables Send, valid enables it', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ data: [] }));
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('portal-users-invite-open'));

    // Empty → disabled, no error yet.
    expect(screen.getByTestId('portal-users-invite-submit')).toBeDisabled();
    expect(screen.queryByTestId('portal-users-invite-email-error')).not.toBeInTheDocument();

    // Malformed → disabled + inline error.
    fireEvent.change(screen.getByTestId('portal-users-invite-email'), { target: { value: 'bad-portal-email' } });
    expect(screen.getByTestId('portal-users-invite-submit')).toBeDisabled();
    expect(screen.getByTestId('portal-users-invite-email-error')).toBeInTheDocument();

    // Valid → enabled, error gone.
    fireEvent.change(screen.getByTestId('portal-users-invite-email'), { target: { value: 'new@acme.example' } });
    expect(screen.getByTestId('portal-users-invite-submit')).not.toBeDisabled();
    expect(screen.queryByTestId('portal-users-invite-email-error')).not.toBeInTheDocument();
  });

  it('confirms before removing a portal user, then issues the DELETE', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: [
        { id: 'pu-1', email: 'gone@acme.example', name: 'G', status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null }
      ] }))                                    // initial list
      .mockResolvedValueOnce(ok({ data: {} })) // DELETE
      .mockResolvedValueOnce(ok({ data: [] })); // reload
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByText('gone@acme.example')).toBeInTheDocument());

    // Clicking Remove opens a confirm dialog — it does NOT delete yet.
    fireEvent.click(screen.getByTestId('portal-user-delete-pu-1'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/gone@acme.example/)).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1); // still just the initial list load

    // Confirming issues the org-scoped DELETE.
    fireEvent.click(screen.getByTestId('portal-user-delete-confirm'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG_ID}/portal-users/pu-1`,
      expect.objectContaining({ method: 'DELETE' })
    ));
  });
});
