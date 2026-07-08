import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
});
