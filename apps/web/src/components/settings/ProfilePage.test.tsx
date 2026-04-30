import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('ProfilePage avatar settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces coming-soon avatar copy with editable avatar URL and saves profile', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        id: 'user-1',
        name: 'Casey Admin',
        email: 'casey@example.com',
        avatarUrl: 'https://cdn.example.com/old-avatar.png',
        mfaEnabled: false
      })
    );

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          avatarUrl: 'https://cdn.example.com/old-avatar.png',
          mfaEnabled: false
        }}
      />
    );

    expect(screen.queryByText(/coming soon/i)).toBeNull();

    const avatarUrlInput = screen.getByLabelText('Avatar image URL');
    fireEvent.change(avatarUrlInput, {
      target: { value: 'https://cdn.example.com/new-avatar.png' }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Profile updated successfully');

    const saveCall = fetchWithAuthMock.mock.calls.find(([url]) => String(url) === '/users/me');
    expect(saveCall).toBeDefined();

    const [, init] = saveCall!;
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(
      JSON.stringify({
        name: 'Casey Admin',
        avatarUrl: 'https://cdn.example.com/new-avatar.png'
      })
    );
  });
});

describe('ProfilePage MFA setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression guard for the bug fixed in PR #543: server requires
  // currentPassword on /auth/mfa/setup, but the client wasn't sending it,
  // breaking MFA enrollment for every user. Without this assertion the
  // server/client schema drift was silent — tsc passed, the page rendered,
  // requests just 400'd in production.
  it('sends currentPassword in the body when starting MFA setup', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' })
    );

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    // Wait for the confirm-password view to mount, then query the MFA-specific
    // input by its id (the page also has a Change Password form with the same
    // "Current password" label, so getByLabelText would be ambiguous).
    await screen.findByText(/Confirm your password/i);
    const passwordInput = document.getElementById('mfa-confirm-password') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    fireEvent.change(passwordInput, { target: { value: 'hunter2-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByText(/Set up authenticator/i);

    const setupCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => String(url) === '/auth/mfa/setup'
    );
    expect(setupCall).toBeDefined();

    const [, init] = setupCall!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ currentPassword: 'hunter2-pw' });
  });
});
