import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #5038 — registering or deleting a passkey rotates the caller's SESSION too.
 *
 * Either write advances `mfa_epoch` and revokes every refresh family (no other
 * live session may survive the account's factor set changing), then hands the
 * actor a replacement session back in the same response. The page has to ADOPT
 * that replacement: keeping the pre-write access token means the next request
 * 401s on the stale `mep` claim, the refresh cookie it would retry with belongs
 * to a revoked family, and the user is bounced to /login?reason=session-expired
 * by the very action they just took. Same contract /mfa/disable adopted in
 * #4934/#5008 and recovery-code rotation in #4480/#4646.
 */

const {
  fetchWithAuthMock,
  createPasskeyCredentialMock,
  commitReissuedSessionIfCurrentMock,
  sessionGeneration,
} = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
  commitReissuedSessionIfCurrentMock: vi.fn(() => true),
  sessionGeneration: 11,
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  useAuthStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ updateUser: vi.fn() }),
    {
      getState: () => ({
        updateUser: vi.fn(),
        sessionGeneration,
        commitReissuedSessionIfCurrent: commitReissuedSessionIfCurrentMock,
      }),
    },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

// Both stubbed so they don't consume from this file's ordered fetchWithAuth
// sequence; their own behavior is covered by their own suites.
vi.mock('./ApproverDevicesSection', () => ({ default: () => null }));
vi.mock('./ConnectSsoCard', () => ({ default: () => null }));

import ProfilePage from './ProfilePage';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const USER = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: true,
  hasPassword: true,
};

const REPLACEMENT = { accessToken: 'reissued-access-token', expiresInSeconds: 900 };

const registrationOptions = { challenge: 'register-challenge', rp: { name: 'Breeze' } };
const credential = { id: 'credential-2', rawId: 'credential-2', type: 'public-key', response: {} };

/** Fill the add-passkey form and submit it. */
async function addPasskey() {
  await screen.findByLabelText(/Passkey name/i);
  fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'iPhone' } });
  fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
    target: { value: 'current-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
}

describe('ProfilePage — passkey writes adopt the replacement session (#5038)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commitReissuedSessionIfCurrentMock.mockReturnValue(true);
    sessionStorage.clear();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('installs the replacement session returned by register/verify', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({
        success: true,
        passkey: { id: 'credential-2', name: 'iPhone' },
        tokens: REPLACEMENT,
      }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-2', name: 'iPhone', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(<ProfilePage initialUser={USER} />);
    await addPasskey();

    await waitFor(() => {
      expect(commitReissuedSessionIfCurrentMock).toHaveBeenCalledWith(sessionGeneration, REPLACEMENT);
    });
    expect(await screen.findByText('Passkey added')).toBeTruthy();
  });

  // Covers both ways the API can omit `tokens`: an older build that never
  // returned one, and the post-commit install failure where it deliberately
  // withholds the replacement (the refresh JTI was never bound, so the access
  // token would die at its first refresh).
  it('does not try to adopt a registration session the API did not return', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, passkey: { id: 'credential-2', name: 'iPhone' } }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-2', name: 'iPhone', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(<ProfilePage initialUser={USER} />);
    await addPasskey();

    expect(await screen.findByText('Passkey added')).toBeTruthy();
    expect(commitReissuedSessionIfCurrentMock).not.toHaveBeenCalled();
  });

  it('installs the replacement session returned by the passkey delete', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }],
      }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, tokens: REPLACEMENT }));

    render(<ProfilePage initialUser={USER} />);
    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(commitReissuedSessionIfCurrentMock).toHaveBeenCalledWith(sessionGeneration, REPLACEMENT);
    });
    expect(await screen.findByText('Passkey deleted')).toBeTruthy();
  });

  it('still reports the deletion when the session moved on and the replacement is refused', async () => {
    // A logout/re-login raced the request: the store refuses the stale-generation
    // commit. The passkey is already gone server-side, so the outcome still has
    // to be shown rather than surfaced as a failure the user would retry.
    commitReissuedSessionIfCurrentMock.mockReturnValue(false);
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }],
      }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, tokens: REPLACEMENT }));

    render(<ProfilePage initialUser={USER} />);
    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Passkey deleted')).toBeTruthy();
  });

  it('does not try to adopt a delete session the API did not return', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }],
      }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true }));

    render(<ProfilePage initialUser={USER} />);
    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Passkey deleted')).toBeTruthy();
    expect(commitReissuedSessionIfCurrentMock).not.toHaveBeenCalled();
  });
});
