import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * #4050 item 2 — the `enroll_first_factor` SSO re-auth grant has a 300s TTL,
 * which a scan-QR-then-type-the-code flow can plausibly outlive. The API now
 * answers that specific failure with `code: 'enrollment_grant_expired'` plus a
 * message that says "start over" instead of the opaque `Invalid credentials`
 * every other step-up rejection shares.
 *
 * These specs pin the CLIENT half: the panel must render the already-localized
 * `ssoReauthProofExpired` copy for that code rather than the server's raw
 * English string — the same copy the page shows when it knows up front that it
 * has no grant left. Without the mapping a French or German operator is told
 * in English that their credentials were invalid, i.e. exactly the "you
 * mistyped the code" misread the API-side change exists to remove.
 */

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn(), sessionGeneration: 0, commitReissuedSessionIfCurrent: vi.fn(() => true) }) }
  )
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
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

/** The API's #4050 expired-grant body, verbatim from routes/auth/helpers.ts. */
const EXPIRED_GRANT_BODY = {
  error: 'Your identity verification has expired. Please verify with your identity provider again.',
  message: 'Your identity verification has expired. Please verify with your identity provider again.',
  code: 'enrollment_grant_expired',
  reauthUrl: '/sso/reauth/start',
};

/** The localized copy the page already owns for this exact situation. */
const LOCALIZED = /Your identity provider verification has expired/i;

const PASSWORDLESS_USER = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: false,
  hasPassword: false,
};

describe('ProfilePage — expired enrollment grant (#4050)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/settings/profile');
  });

  it('renders the localized expiry copy when /auth/mfa/setup rejects the grant as expired', async () => {
    window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=grant-abc');
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/setup') return makeJsonResponse(EXPIRED_GRANT_BODY, false, 400);
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={PASSWORDLESS_USER} />);

    expect(await screen.findByText(LOCALIZED)).toBeTruthy();
    // ...and NOT the server's raw English, which is what a bare
    // `errorData.error ?? errorData.message` passthrough would render.
    expect(screen.queryByText(/Please verify with your identity provider again/i)).toBeNull();
  });

  it('renders the localized expiry copy when the terminal /auth/mfa/enable write rejects the grant', async () => {
    window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=grant-abc');
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
      }
      if (String(url) === '/auth/mfa/enable') return makeJsonResponse(EXPIRED_GRANT_BODY, false, 400);
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={PASSWORDLESS_USER} />);
    await screen.findByText(/Set up authenticator/i);

    const digitInputs = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
    expect(digitInputs.length).toBe(6);
    digitInputs.forEach((input, index) => {
      fireEvent.change(input, { target: { value: String(index + 1) } });
    });
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    await waitFor(() => expect(screen.getByText(LOCALIZED)).toBeTruthy());
  });

  it('still renders the server message verbatim for any OTHER rejection code', async () => {
    window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=grant-abc');
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
      if (String(url) === '/auth/mfa/setup') {
        return makeJsonResponse(
          { error: 'Invalid credentials', message: 'Invalid credentials', code: 'invalid_credentials' },
          false,
          400,
        );
      }
      return undefined as unknown as Response;
    });

    render(<ProfilePage initialUser={PASSWORDLESS_USER} />);

    expect(await screen.findByText('Invalid credentials')).toBeTruthy();
    expect(screen.queryByText(LOCALIZED)).toBeNull();
  });
});
