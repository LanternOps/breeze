import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  apiPreviewInvite: vi.fn(),
  apiAcceptInvite: vi.fn(),
  fetchAndApplyPreferences: vi.fn(),
  login: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  apiPreviewInvite: authMocks.apiPreviewInvite,
  apiAcceptInvite: authMocks.apiAcceptInvite,
  fetchAndApplyPreferences: authMocks.fetchAndApplyPreferences,
  useAuthStore: {
    getState: () => ({ login: authMocks.login }),
  },
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import AcceptInvitePage from './AcceptInvitePage';

describe('AcceptInvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
