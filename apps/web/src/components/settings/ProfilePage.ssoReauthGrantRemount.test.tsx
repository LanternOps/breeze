import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #8862 — an SSO-only technician could not add a passkey: the IdP round-trip
 * completed (`sso.reauth.completed`), the page came back, and the passkey card
 * still said "Verify with your identity provider". The grant arrives once, in
 * `#ssoReauthGrant=<id>`, which the page strips as it reads it; until this fix
 * it then lived only in React state, so ANY second mount of the page lost it.
 * TOTP never noticed because it spends the grant on /mfa/setup during the
 * first mount; the passkey card waits for a click.
 *
 * These specs pin the fix: the grant is mirrored into sessionStorage beside the
 * #4055 intent, restored on a mount that has no fragment, and removed wherever
 * the page drops it (spent, or rejected as dead) — plus a client TTL that never
 * outlives the server's 300 s.
 */

const { fetchWithAuthMock, createPasskeyCredentialMock, authState } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
  authState: { user: { id: 'user-1' } as { id: string } | null },
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  getPasskeyCredential: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ updateUser: vi.fn() }),
    {
      getState: () => ({
        user: authState.user,
        updateUser: vi.fn(),
        sessionGeneration: 0,
        commitReissuedSessionIfCurrent: vi.fn(() => true),
      }),
    },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));
vi.mock('./ApproverDevicesSection', () => ({ default: () => null }));
vi.mock('./TicketPushoverSettings', () => ({ default: () => null }));
vi.mock('./EmailNotificationSettings', () => ({ default: () => null }));
vi.mock('./ConnectSsoCard', () => ({ default: () => null }));

import ProfilePage from './ProfilePage';
import { stashSsoReauthIntent, type SsoReauthIntent } from '@/lib/ssoReauthIntent';
import {
  SSO_REAUTH_GRANT_CLIENT_TTL_MS,
  SSO_REAUTH_GRANT_KEY,
  stashSsoReauthGrant,
} from '@/lib/ssoReauthGrant';

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
const EXPIRED_GRANT_BODY = {
  error: 'Your identity verification has expired. Please verify with your identity provider again.',
  code: 'enrollment_grant_expired',
  reauthUrl: '/sso/reauth/start',
};

const passwordlessUser = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: false,
  hasPassword: false,
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function callTo(url: string) {
  return fetchWithAuthMock.mock.calls.filter(([u]) => String(u) === url);
}

type Overrides = Record<string, () => Response>;
function routeFetch(overrides: Overrides = {}) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (overrides[u]) return overrides[u]();
    if (u === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
    if (u === '/auth/mfa/setup') return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc', secret: 'ABC' });
    if (u === '/auth/passkeys/register/options') return makeJsonResponse({ options: REGISTRATION_OPTIONS });
    if (u === '/auth/passkeys/register/verify') {
      return makeJsonResponse({
        passkey: { id: 'credential-1', name: 'YubiKey' },
        tokens: { accessToken: 'reissued-access-token', expiresInSeconds: 900 },
      });
    }
    if (u === '/auth/mfa/enable') return makeJsonResponse({ recoveryCodes: ['code-1'] });
    return makeJsonResponse({});
  });
}

/** The IdP return leg: the callback's fragment plus the card the trip started from. */
function landFromIdp(intent: SsoReauthIntent) {
  stashSsoReauthIntent(intent);
  window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);
}

async function mountPage() {
  const view = render(<ProfilePage initialUser={passwordlessUser} />);
  await screen.findByText(/No passkeys are registered/i);
  return view;
}

/** Unmount and mount again with whatever URL the first mount left behind. */
async function remount(view: ReturnType<typeof render>) {
  view.unmount();
  // The first mount must have stripped the single-use fragment: the remount is
  // what used to arrive with nothing to read.
  expect(window.location.hash).toBe('');
  return mountPage();
}

describe('ProfilePage — SSO re-auth grant survives a remount (#8862)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 'user-1' };
    sessionStorage.clear();
    window.history.replaceState(null, '', '/settings/profile');
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the passkey card armed after a remount without the fragment, and spends the SAME grant', async () => {
    landFromIdp('passkey');
    routeFetch();
    createPasskeyCredentialMock.mockResolvedValueOnce(CREDENTIAL);

    const first = await mountPage();
    expect(screen.getByTestId('passkey-add')).toBeTruthy();

    await remount(first);

    // The reported dead end: this used to be `passkey-sso-reauth`.
    expect(screen.getByTestId('passkey-add')).toBeTruthy();
    expect(screen.queryByTestId('passkey-sso-reauth')).toBeNull();
    expect(screen.getByText(/Your identity is verified/i)).toBeTruthy();
    // Restoring the passkey road must not mint a TOTP secret either (#4055).
    expect(callTo('/auth/mfa/setup')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'YubiKey' } });
    fireEvent.click(screen.getByTestId('passkey-add'));
    await screen.findByText('Passkey added');

    expect(JSON.parse(String(callTo('/auth/passkeys/register/options')[0][1]?.body)).ssoReauthGrantId).toBe(GRANT);
    expect(JSON.parse(String(callTo('/auth/passkeys/register/verify')[0][1]?.body)).ssoReauthGrantId).toBe(GRANT);
  });

  it('clears the stash once register/verify spends the grant, so a later mount cannot reuse it', async () => {
    landFromIdp('passkey');
    routeFetch();
    createPasskeyCredentialMock.mockResolvedValueOnce(CREDENTIAL);

    const first = await mountPage();
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'YubiKey' } });
    fireEvent.click(screen.getByTestId('passkey-add'));
    await screen.findByText('Passkey added');

    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();

    await remount(first);
    expect(screen.getByTestId('passkey-sso-reauth')).toBeTruthy();
    expect(screen.queryByTestId('passkey-add')).toBeNull();
    expect(callTo('/auth/passkeys/register/options')).toHaveLength(1);
  });

  it('clears the stash once /mfa/enable spends the grant on the TOTP road', async () => {
    landFromIdp('totp');
    routeFetch();

    render(<ProfilePage initialUser={passwordlessUser} />);
    await screen.findByText(/Set up authenticator/i);
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).not.toBeNull();

    const digitInputs = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
    digitInputs.forEach((input, index) => {
      fireEvent.change(input, { target: { value: String(index + 1) } });
    });
    fireEvent.click(screen.getByRole('button', { name: /Verify and enable/i }));

    await waitFor(() => expect(callTo('/auth/mfa/enable')).toHaveLength(1));
    expect(JSON.parse(String(callTo('/auth/mfa/enable')[0][1]?.body)).ssoReauthGrantId).toBe(GRANT);
    await waitFor(() => expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull());
  });

  it('restores the TOTP road on a remount by re-issuing setup with the same grant', async () => {
    landFromIdp('totp');
    routeFetch();

    const first = render(<ProfilePage initialUser={passwordlessUser} />);
    await screen.findByText(/Set up authenticator/i);
    first.unmount();
    expect(window.location.hash).toBe('');

    render(<ProfilePage initialUser={passwordlessUser} />);
    await screen.findByText(/Set up authenticator/i);

    const setupCalls = callTo('/auth/mfa/setup');
    expect(setupCalls).toHaveLength(2);
    expect(JSON.parse(String(setupCalls[1][1]?.body))).toEqual({ ssoReauthGrantId: GRANT });
  });

  it('drops the stash when the server rejects the grant as dead, and does not offer it again', async () => {
    landFromIdp('passkey');
    routeFetch({
      '/auth/passkeys/register/options': () => makeJsonResponse(EXPIRED_GRANT_BODY, false, 400),
    });

    const first = await mountPage();
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'YubiKey' } });
    fireEvent.click(screen.getByTestId('passkey-add'));
    expect(await screen.findByTestId('passkey-sso-reauth')).toBeTruthy();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();

    await remount(first);
    expect(screen.getByTestId('passkey-sso-reauth')).toBeTruthy();
    expect(screen.queryByTestId('passkey-add')).toBeNull();
  });

  it('keeps the stash after a cancelled WebAuthn ceremony, because the grant is still unspent', async () => {
    landFromIdp('passkey');
    routeFetch();
    const cancelled = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
    createPasskeyCredentialMock.mockRejectedValueOnce(cancelled);

    const first = await mountPage();
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'YubiKey' } });
    fireEvent.click(screen.getByTestId('passkey-add'));
    await screen.findByText(/canceled or timed out/i);

    await remount(first);
    expect(screen.getByTestId('passkey-add')).toBeTruthy();
  });

  it('does not restore a stash older than the client TTL', async () => {
    const t0 = Date.now();
    stashSsoReauthGrant(GRANT, 'passkey', 'user-1', t0);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + SSO_REAUTH_GRANT_CLIENT_TTL_MS + 1);
    routeFetch();

    await mountPage();

    expect(screen.getByTestId('passkey-sso-reauth')).toBeTruthy();
    expect(screen.queryByTestId('passkey-add')).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });

  it('does not restore another account\'s grant on the same tab', async () => {
    stashSsoReauthGrant(GRANT, 'passkey', 'someone-else');
    routeFetch();

    await mountPage();

    expect(screen.getByTestId('passkey-sso-reauth')).toBeTruthy();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });

  // A grant the page did not adopt (here: no user was known at mount — the
  // auth store is empty and the page is still fetching /users/me — so the stash
  // could not be checked) must not outlive a NEW trip, or it could be restored
  // against the new trip's intent if that trip comes back with an error.
  it('clears a leftover grant when a new IdP trip starts', async () => {
    stashSsoReauthGrant(GRANT, 'passkey', 'user-1');
    authState.user = null;
    routeFetch({
      '/users/me': () => makeJsonResponse(passwordlessUser),
      '/sso/reauth/start': () => makeJsonResponse({ authUrl: 'https://idp.example.com/authorize' }),
    });
    const assignMock = vi.fn();
    const realLocation = window.location;

    try {
      render(<ProfilePage />);
      await screen.findByText(/No passkeys are registered/i);
      expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).not.toBeNull();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { assign: assignMock, hash: '', search: '', pathname: '/settings/profile' },
      });

      fireEvent.click(screen.getByTestId('passkey-sso-reauth'));
      await waitFor(() => expect(assignMock).toHaveBeenCalledWith('https://idp.example.com/authorize'));

      expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  // StrictMode's dev-only effect replay keeps the component instance (and its
  // ref) but runs the mount effect twice. The second pass finds no fragment and
  // a freshly written stash — without the routed-ref guard it would restore the
  // grant and fire a SECOND /mfa/setup, minting a second TOTP secret.
  it('routes once under StrictMode: a single /mfa/setup on the TOTP landing', async () => {
    landFromIdp('totp');
    routeFetch();

    render(<StrictMode><ProfilePage initialUser={passwordlessUser} /></StrictMode>);
    await screen.findByText(/Set up authenticator/i);
    await new Promise((r) => setTimeout(r, 50));

    expect(callTo('/auth/mfa/setup')).toHaveLength(1);
  });

  it('overwrites an older stash with the grant and intent the fragment brings back', async () => {
    stashSsoReauthGrant('11111111-2222-4333-8444-555555555555', 'passkey', 'user-1');
    landFromIdp('totp');
    routeFetch();

    render(<ProfilePage initialUser={passwordlessUser} />);
    await screen.findByText(/Set up authenticator/i);

    expect(JSON.parse(String(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY))))
      .toMatchObject({ grantId: GRANT, intent: 'totp', userId: 'user-1' });
    expect(JSON.parse(String(callTo('/auth/mfa/setup')[0][1]?.body))).toEqual({ ssoReauthGrantId: GRANT });
  });

  it('falls back to the page user when the auth store has no user yet', async () => {
    authState.user = null;
    landFromIdp('passkey');
    routeFetch();

    await mountPage();

    expect(JSON.parse(String(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY))))
      .toMatchObject({ grantId: GRANT, userId: 'user-1' });
  });

  // #4045 management trips: the grant stands in for the password on one
  // action, and a remount must put the user back on that action's view.
  describe('factor-management intents (#4045)', () => {
    const enrolledUser = { ...passwordlessUser, mfaEnabled: true, mfaMethod: 'totp' as const };
    const fillDigits = (value: string) => {
      document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"][maxlength="1"]')
        .forEach((input, index) => fireEvent.change(input, { target: { value: value[index] } }));
    };

    async function landThenRemount(intent: SsoReauthIntent, passkeys: unknown[] = []) {
      landFromIdp(intent);
      routeFetch({
        '/auth/passkeys': () => makeJsonResponse({ passkeys }),
        '/auth/mfa/disable': () => makeJsonResponse({ success: true }),
      });
      const first = render(<ProfilePage initialUser={enrolledUser} />);
      await waitFor(() => expect(callTo('/auth/passkeys').length).toBeGreaterThan(0));
      first.unmount();
      expect(window.location.hash).toBe('');
      render(<ProfilePage initialUser={enrolledUser} />);
    }

    it('reopens the recovery-code view on a remount', async () => {
      await landThenRemount('recovery_codes');

      expect(await screen.findByTestId('mfa-recovery-regenerate')).toBeTruthy();
      expect(screen.queryByTestId('mfa-recovery-sso-reauth')).toBeNull();
      expect(callTo('/auth/mfa/setup')).toHaveLength(0);
    });

    it('reopens the disable view on a remount, and the spend clears the stash', async () => {
      await landThenRemount('disable_mfa');

      const submit = await screen.findByRole('button', { name: /^Disable MFA$/i });
      expect(callTo('/auth/mfa/setup')).toHaveLength(0);
      fillDigits('654321');
      fireEvent.click(submit);
      await screen.findByText(/Multi-factor authentication disabled/i);

      expect(JSON.parse(String(callTo('/auth/mfa/disable')[0][1]?.body)))
        .toEqual({ code: '654321', ssoReauthGrantId: GRANT });
      expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
    });

    it('returns ready to delete a passkey on a remount', async () => {
      await landThenRemount('delete_passkey', [{ id: 'pk-1', name: 'YubiKey' }]);

      expect(await screen.findByText(/Identity verified\. Choose Delete on the passkey/i)).toBeTruthy();
      expect(screen.queryByTestId('passkey-delete-sso-reauth')).toBeNull();
      expect(callTo('/auth/mfa/setup')).toHaveLength(0);
    });

    it('clears the stash when a management action rejects the grant as dead', async () => {
      landFromIdp('disable_mfa');
      routeFetch({
        '/auth/mfa/disable': () => makeJsonResponse({
          error: 'Your identity verification has expired.',
          code: 'sso_reauth_grant_expired',
        }, false, 400),
      });
      render(<ProfilePage initialUser={enrolledUser} />);

      const submit = await screen.findByRole('button', { name: /^Disable MFA$/i });
      fillDigits('654321');
      fireEvent.click(submit);
      await screen.findByText(/verification has expired\. Verify again to confirm this change/i);

      expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
    });
  });

  it('ignores a non-UUID #ssoReauthGrant fragment: no request, fragment stripped', async () => {
    routeFetch();
    window.history.replaceState(null, '', '/settings/profile#ssoReauthGrant=not-a-uuid');

    await mountPage();

    expect(callTo('/auth/mfa/setup')).toHaveLength(0);
    expect(screen.queryByText(/Invalid UUID/i)).toBeNull();
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });
});
