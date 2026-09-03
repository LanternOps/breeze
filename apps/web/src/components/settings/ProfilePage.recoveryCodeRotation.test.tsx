import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * #4480 — regenerating recovery codes rotates the caller's SESSION too.
 *
 * The API advances `mfa_epoch` and revokes every refresh family (so a stale
 * code set can never stay usable from another live session), then hands the
 * actor a replacement session back in the same response. The page has to ADOPT
 * that replacement: leaving the pre-rotation access token installed means the
 * next request 401s, the refresh cookie it would retry with belongs to a family
 * that no longer exists in the store's memory, and the user is bounced to
 * /login while the one-time codes are still on screen.
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

async function regenerate() {
  fireEvent.click(await screen.findByTestId('mfa-recovery-regenerate-start'));
  const password = document.getElementById('mfa-recovery-password') as HTMLInputElement;
  fireEvent.change(password, { target: { value: 'hunter2-pw' } });
  fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
  fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));
}

describe('ProfilePage — recovery-code rotation adopts the replacement session (#4480)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commitReissuedSessionIfCurrentMock.mockReturnValue(true);
    window.history.replaceState(null, '', '/settings/profile');
  });

  it('installs the replacement access token and still shows the new codes', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/recovery-codes') {
        return makeJsonResponse({
          success: true,
          recoveryCodes: ['NEW-0001', 'NEW-0002'],
          tokens: { accessToken: 'rotated-access-token', expiresInSeconds: 900 },
        });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={MFA_USER} />);
    await regenerate();

    await waitFor(() => {
      expect(commitReissuedSessionIfCurrentMock).toHaveBeenCalledWith(
        sessionGeneration,
        { accessToken: 'rotated-access-token', expiresInSeconds: 900 },
      );
    });
    expect(await screen.findByText('NEW-0001')).toBeTruthy();
  });

  it('still reveals the codes when the session moved on and the replacement is refused', async () => {
    // A logout/re-login raced the rotation: the store refuses the stale-generation
    // commit. The codes are already minted and the old set is already dead, so
    // hiding them would strand the user — reveal them anyway.
    commitReissuedSessionIfCurrentMock.mockReturnValue(false);
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/recovery-codes') {
        return makeJsonResponse({
          success: true,
          recoveryCodes: ['NEW-0003'],
          tokens: { accessToken: 'rotated-access-token', expiresInSeconds: 900 },
        });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={MFA_USER} />);
    await regenerate();

    expect(await screen.findByText('NEW-0003')).toBeTruthy();
  });

  it('does not try to adopt a session an older API build never returned', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/recovery-codes') {
        return makeJsonResponse({ success: true, recoveryCodes: ['NEW-0004'] });
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={MFA_USER} />);
    await regenerate();

    expect(await screen.findByText('NEW-0004')).toBeTruthy();
    expect(commitReissuedSessionIfCurrentMock).not.toHaveBeenCalled();
  });
});
