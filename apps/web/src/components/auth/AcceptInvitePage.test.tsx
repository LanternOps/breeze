import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  apiPreviewInvite: vi.fn(),
  apiAcceptInvite: vi.fn(),
  fetchAndApplyPreferences: vi.fn(),
  login: vi.fn(),
  currentInstalledSession: vi.fn(() => true),
}));

vi.mock('../../stores/auth', () => ({
  apiPreviewInvite: authMocks.apiPreviewInvite,
  apiAcceptInvite: authMocks.apiAcceptInvite,
  fetchAndApplyPreferences: authMocks.fetchAndApplyPreferences,
  isInstalledAuthSessionCurrent: authMocks.currentInstalledSession,
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import AcceptInvitePage from './AcceptInvitePage';

describe('AcceptInvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.currentInstalledSession.mockReturnValue(true);
    authMocks.fetchAndApplyPreferences.mockResolvedValue(undefined);
    window.history.replaceState({}, '', '/accept-invite?token=invite-token&utm_source=email');
    authMocks.apiPreviewInvite.mockImplementation(async () => {
      expect(window.location.href).not.toContain('invite-token');
      return { success: true, email: 'invitee@example.com', orgName: 'Acme' };
    });
  });

  it('scrubs the invite token before previewing it', async () => {
    render(<AcceptInvitePage />);

    await waitFor(() => {
      expect(authMocks.apiPreviewInvite).toHaveBeenCalledWith('invite-token');
    });

    expect(window.location.pathname).toBe('/accept-invite');
    expect(window.location.search).toBe('?utm_source=email');
  });

  async function submitInvite() {
    fireEvent.input(screen.getByLabelText(/new password/i), { target: { value: 'StrongPass123!' } });
    fireEvent.input(screen.getByLabelText(/confirm password/i), { target: { value: 'StrongPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: /set password & sign in/i }));
  }

  it('suppresses preferences and navigation when invite session is already stale', async () => {
    authMocks.apiAcceptInvite.mockResolvedValueOnce({
      success: true,
      user: { id: 'user-a' },
      tokens: { accessToken: 'access-a' },
      installedSession: { generation: 1, userId: 'user-a', accessToken: 'access-a' },
    });
    authMocks.currentInstalledSession.mockReturnValue(false);
    render(<AcceptInvitePage />);
    await waitFor(() => expect(authMocks.apiPreviewInvite).toHaveBeenCalled());

    await submitInvite();

    await waitFor(() => expect(authMocks.apiAcceptInvite).toHaveBeenCalledOnce());
    expect(authMocks.fetchAndApplyPreferences).not.toHaveBeenCalled();
    const { navigateTo } = await import('../../lib/navigation');
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('suppresses navigation when a newer session installs while preferences load', async () => {
    authMocks.apiAcceptInvite.mockResolvedValueOnce({
      success: true,
      user: { id: 'user-a' },
      tokens: { accessToken: 'access-a' },
      installedSession: { generation: 1, userId: 'user-a', accessToken: 'access-a' },
    });
    authMocks.currentInstalledSession.mockReturnValueOnce(true).mockReturnValue(false);
    render(<AcceptInvitePage />);
    await waitFor(() => expect(authMocks.apiPreviewInvite).toHaveBeenCalled());

    await submitInvite();

    await waitFor(() => expect(authMocks.fetchAndApplyPreferences).toHaveBeenCalledOnce());
    const { navigateTo } = await import('../../lib/navigation');
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
