import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, createPasskeyCredentialMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  useAuthStore: Object.assign(
    (selector: any) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn() }) },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

// The Approval-security section loads its own approver devices on mount via the
// authenticator store; stub it so it doesn't consume from this file's ordered
// fetchWithAuth mock sequence. Its own behavior is covered by
// ApproverDevicesSection.test.tsx.
vi.mock('./ApproverDevicesSection', () => ({
  default: () => null,
}));

// ConnectSsoCard (#2183) fetches /sso/link/options on mount; stub it so it
// doesn't consume from this file's ordered fetchWithAuth mock sequence. Its own
// behavior is covered by ConnectSsoCard.test.tsx.
vi.mock('./ConnectSsoCard', () => ({
  default: () => null,
}));

import ProfilePage from './ProfilePage';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('ProfilePage passkey management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('starts passkey registration with currentPassword and verifies the browser credential', async () => {
    const registrationOptions = {
      challenge: 'register-challenge',
      rp: { name: 'Breeze' },
      user: { id: 'user-1', name: 'casey@example.com', displayName: 'Casey Admin' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    };
    const credential = {
      id: 'credential-1',
      rawId: 'credential-1',
      type: 'public-key',
      response: {
        attestationObject: 'attestation',
        clientDataJSON: 'client-data',
      },
    };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ passkey: { id: 'credential-1', name: 'MacBook Touch ID' } }))
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }],
      }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
        }}
      />,
    );

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), {
      target: { value: 'MacBook Touch ID' },
    });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/register/options',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'current-password', name: 'MacBook Touch ID' }),
      }),
    ]);
    expect(createPasskeyCredentialMock).toHaveBeenCalledWith(registrationOptions);
    expect(fetchWithAuthMock.mock.calls[2]).toEqual([
      '/auth/passkeys/register/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'MacBook Touch ID', credential }),
      }),
    ]);
    await waitFor(() => expect(screen.getByText('MacBook Touch ID')).toBeTruthy());
  });

  it('sends currentPassword when deleting a passkey', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }],
      }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true }));

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
        }}
      />,
    );

    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await screen.findByText('Passkey deleted');

    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/credential-1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: 'current-password' }),
      }),
    ]);
  });

  // #4018: a passwordless SSO account has no password to prove, so it proves
  // identity with a fresh forced IdP round-trip instead. The API accepted
  // `ssoReauthGrantId` on both register endpoints from the start and had no
  // caller — a passwordless user simply could not register a passkey.
  describe('passwordless SSO account (#4018)', () => {
    // Both endpoints type it as z.string().uuid() (mintStepUpGrant returns
    // randomUUID()), so a non-UUID fixture would 400 before the road is reached.
    const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    const REGISTRATION_OPTIONS = {
      challenge: 'register-challenge',
      rp: { name: 'Breeze' },
      user: { id: 'user-1', name: 'casey@example.com', displayName: 'Casey Admin' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    };
    const CREDENTIAL = {
      id: 'credential-1',
      rawId: 'credential-1',
      type: 'public-key',
      response: { attestationObject: 'attestation', clientDataJSON: 'client-data' },
    };

    const passwordlessUser = {
      id: 'user-1',
      name: 'Casey Admin',
      email: 'casey@example.com',
      mfaEnabled: false,
      hasPassword: false,
    };

    function callTo(url: string) {
      return fetchWithAuthMock.mock.calls.filter(([u]) => String(u) === url);
    }

    it('sends the SAME grant to BOTH register/options and register/verify', async () => {
      // Arriving back from the IdP: the callback hands the grant over in the
      // fragment, and ProfilePage holds it for whichever road spends it first.
      window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);

      fetchWithAuthMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
        if (u === '/auth/mfa/setup') return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc' });
        if (u === '/auth/passkeys/register/options') return makeJsonResponse({ options: REGISTRATION_OPTIONS });
        if (u === '/auth/passkeys/register/verify') {
          return makeJsonResponse({ passkey: { id: 'credential-1', name: 'YubiKey' } });
        }
        return makeJsonResponse({});
      });
      createPasskeyCredentialMock.mockResolvedValueOnce(CREDENTIAL);

      render(<ProfilePage initialUser={passwordlessUser} />);

      await screen.findByText(/No passkeys are registered/i);
      // No password field at all for an account that has no password.
      expect(document.querySelector('#passkey-password')).toBeNull();

      fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'YubiKey' } });
      fireEvent.click(screen.getByTestId('passkey-add'));

      await screen.findByText('Passkey added');

      // BOTH call sites, asserted independently: register/options only
      // VALIDATES the grant, register/verify CONSUMES it. Sending it to one and
      // not the other yields a 401 after a successful WebAuthn ceremony.
      const optionsCalls = callTo('/auth/passkeys/register/options');
      expect(optionsCalls).toHaveLength(1);
      expect(JSON.parse(String(optionsCalls[0][1]?.body)))
        .toEqual({ ssoReauthGrantId: GRANT, name: 'YubiKey' });

      const verifyCalls = callTo('/auth/passkeys/register/verify');
      expect(verifyCalls).toHaveLength(1);
      const verifyBody = JSON.parse(String(verifyCalls[0][1]?.body));
      expect(verifyBody.ssoReauthGrantId).toBe(GRANT);
      expect(verifyBody).toMatchObject({ name: 'YubiKey', credential: CREDENTIAL });

      // The SAME id, not a second one minted in between: a fresh grant would be
      // bound to different epochs and the consume would fail closed.
      expect(JSON.parse(String(optionsCalls[0][1]?.body)).ssoReauthGrantId)
        .toBe(verifyBody.ssoReauthGrantId);

      // Neither call carries a password — there is none.
      expect(JSON.parse(String(optionsCalls[0][1]?.body)).currentPassword).toBeUndefined();
      expect(verifyBody.currentPassword).toBeUndefined();
    });

    it('issues NO request and offers IdP re-verification when the grant is missing', async () => {
      window.history.replaceState(null, '', '/settings/profile');
      fetchWithAuthMock.mockImplementation(async (url: string) => {
        if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
        return makeJsonResponse({});
      });

      render(<ProfilePage initialUser={passwordlessUser} />);

      await screen.findByText(/No passkeys are registered/i);

      // The submit is replaced by the CTA that can actually resolve this.
      expect(screen.getByTestId('passkey-sso-reauth')).toBeTruthy();
      expect(screen.queryByTestId('passkey-add')).toBeNull();
      expect(document.querySelector('#passkey-password')).toBeNull();

      // And nothing proofless is ever sent.
      expect(callTo('/auth/passkeys/register/options')).toHaveLength(0);
      expect(callTo('/auth/passkeys/register/verify')).toHaveLength(0);
      expect(createPasskeyCredentialMock).not.toHaveBeenCalled();
    });

    it('starts the IdP round-trip from the passkey card', async () => {
      window.history.replaceState(null, '', '/settings/profile');
      const assignMock = vi.fn();
      const realLocation = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { assign: assignMock, hash: '', search: '', pathname: '/settings/profile' },
      });

      fetchWithAuthMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
        if (u === '/sso/reauth/start') {
          return makeJsonResponse({ authUrl: 'https://idp.example.com/authorize?prompt=login' });
        }
        return makeJsonResponse({});
      });

      render(<ProfilePage initialUser={passwordlessUser} />);
      await screen.findByText(/No passkeys are registered/i);
      fireEvent.click(screen.getByTestId('passkey-sso-reauth'));

      await waitFor(() => {
        expect(assignMock).toHaveBeenCalledWith('https://idp.example.com/authorize?prompt=login');
      });
      expect(callTo('/sso/reauth/start')).toHaveLength(1);

      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    });

    // hasPassword absent is UNKNOWN, not passwordless — the password road must
    // survive a session persisted before /users/me carried the field.
    it('keeps the password road for an account whose hasPassword is unknown', async () => {
      window.history.replaceState(null, '', '/settings/profile');
      fetchWithAuthMock.mockImplementation(async (url: string) => {
        if (String(url) === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
        return makeJsonResponse({});
      });

      render(
        <ProfilePage
          initialUser={{ id: 'user-1', name: 'Casey Admin', email: 'casey@example.com', mfaEnabled: false }}
        />,
      );

      await screen.findByText(/No passkeys are registered/i);
      expect(document.querySelector('#passkey-password')).toBeTruthy();
      expect(screen.queryByTestId('passkey-sso-reauth')).toBeNull();
    });
  });
});
