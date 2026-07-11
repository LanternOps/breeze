import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import OrgPortalUsersEditor from './OrgPortalUsersEditor';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => (data) });

beforeEach(() => { vi.clearAllMocks(); });

describe('OrgPortalUsersEditor', () => {
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
