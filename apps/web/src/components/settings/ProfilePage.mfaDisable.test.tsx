import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * #4934 — disabling MFA rotates the caller's SESSION too.
 *
 * Removing the factor advances `mfa_epoch` and revokes every refresh family (no
 * other live session may survive the account losing its second factor), then
 * hands the actor a replacement session back in the same response. The page has
 * to ADOPT that replacement: keeping the pre-disable access token means the next
 * request 401s on the stale `mep` claim, the refresh cookie it would retry with
 * belongs to a revoked family, and the user is bounced to
 * /login?reason=session-expired by the very action they just took. Same contract
 * recovery-code rotation adopted in #4480/#4646.
 */

const { commitReissuedSessionIfCurrentMock, sessionGeneration } = vi.hoisted(() => ({
  commitReissuedSessionIfCurrentMock: vi.fn(() => true),
  sessionGeneration: 7,
}));

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ updateUser: vi.fn() }),
    {
      getState: () => ({
        updateUser: vi.fn(),
        sessionGeneration,
        commitReissuedSessionIfCurrent: commitReissuedSessionIfCurrentMock,
      }),
    },
  ),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

vi.mock('./ApproverDevicesSection', () => ({
  default: () => null,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const MFA_USER = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: true,
  mfaMethod: 'totp',
  hasPassword: true,
};

/** Open the disable panel, fill the six code digits plus the password, submit. */
async function disableMfa() {
  fireEvent.click(await screen.findByRole('button', { name: /^Disable$/i }));
  const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
  digits.forEach((input, index) => {
    fireEvent.change(input, { target: { value: String(index + 1) } });
  });
  const password = document.getElementById('mfa-disable-password') as HTMLInputElement;
  fireEvent.change(password, { target: { value: 'hunter2-pw' } });
  fireEvent.click(screen.getByRole('button', { name: /^Disable MFA$/i }));
}

describe('ProfilePage — disabling MFA adopts the replacement session (#4934)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commitReissuedSessionIfCurrentMock.mockReturnValue(true);
    window.history.replaceState(null, '', '/settings/profile');
  });

  it('installs the replacement access token and still reports the disable', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/disable') {
        return makeJsonResponse({
          success: true,
          message: 'MFA disabled successfully',
          tokens: { accessToken: 'reissued-access-token', expiresInSeconds: 900 },
        });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={MFA_USER} />);
    await disableMfa();

    await waitFor(() => {
      expect(commitReissuedSessionIfCurrentMock).toHaveBeenCalledWith(
        sessionGeneration,
        { accessToken: 'reissued-access-token', expiresInSeconds: 900 },
      );
    });
    expect(await screen.findByText(/Multi-factor authentication disabled/i)).toBeTruthy();
  });

  it('still reports the disable when the session moved on and the replacement is refused', async () => {
    // A logout/re-login raced the request: the store refuses the stale-generation
    // commit. MFA is already off server-side, so the outcome still has to be
    // shown rather than surfaced as a failure the user would retry.
    commitReissuedSessionIfCurrentMock.mockReturnValue(false);
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/disable') {
        return makeJsonResponse({
          success: true,
          tokens: { accessToken: 'reissued-access-token', expiresInSeconds: 900 },
        });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={MFA_USER} />);
    await disableMfa();

    expect(await screen.findByText(/Multi-factor authentication disabled/i)).toBeTruthy();
  });

  // Covers both ways the API can omit `tokens`: an older build that never
  // returned one, and the post-commit install failure where it deliberately
  // withholds the replacement (the refresh JTI was never bound, so the access
  // token would die at its first refresh).
  it('does not try to adopt a session the API did not return', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/disable') {
        return makeJsonResponse({ success: true, message: 'MFA disabled successfully' });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={MFA_USER} />);
    await disableMfa();

    expect(await screen.findByText(/Multi-factor authentication disabled/i)).toBeTruthy();
    expect(commitReissuedSessionIfCurrentMock).not.toHaveBeenCalled();
  });
});
