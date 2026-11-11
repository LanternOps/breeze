import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';
import { SSO_REAUTH_INTENT_KEY, stashSsoReauthIntent } from '@/lib/ssoReauthIntent';
import { SSO_REAUTH_GRANT_KEY } from '@/lib/ssoReauthGrant';

/**
 * #9007 — an SSO-only account (no password, no passkey, no TOTP) could not
 * register an approver device: the "Register this browser" form asked for a
 * password the account does not have. The approver section now offers the same
 * IdP round-trip the MFA cards use, and the grant that comes back is exchanged
 * once at POST /authenticator/register-grant.
 *
 * These specs pin the ProfilePage half: the trip records `approver_device`
 * before leaving, the return leg lands on the register form WITHOUT running the
 * TOTP enrollment road, and a grant the exchange spent or refused is dropped
 * page-wide so no card keeps advertising it. The real ApproverDevicesSection
 * and store run against the mocked `fetchWithAuth`.
 */

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    { getState: () => ({
      updateUser: vi.fn(),
      sessionGeneration: 0,
      commitMfaEnrollmentIfCurrent: vi.fn(() => true),
      commitMfaDisableIfCurrent: vi.fn(() => true),
      commitReissuedSessionIfCurrent: vi.fn(() => true), commitMfaStateIfCurrent: vi.fn(() => true),
    }) },
  ),
}));

const { showToastMock, startRegistrationMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
  startRegistrationMock: vi.fn(),
}));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: startRegistrationMock,
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

// Both fetch on mount; stub them so they don't consume this file's mocks.
vi.mock('./TicketPushoverSettings', () => ({ default: () => null }));
vi.mock('./EmailNotificationSettings', () => ({ default: () => null }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const GRANT = '8a5f3c2e-1b4d-4e6f-9a0b-1c2d3e4f5a6b';
const AUTH_URL = 'https://idp.example.com/authorize?prompt=login';
const SSO_EXPIRED = 'Your identity provider verification has expired or was already used. Verify again to register this device.';

const PASSWORDLESS_NO_FACTOR_USER = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: false,
  mfaMethod: null,
  hasPassword: false,
};

const REAL_LOCATION = window.location;

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mockApi(extra: Handler = () => undefined) {
  fetchWithAuthMock.mockImplementation(async (url, init) => {
    const u = String(url);
    const handled = extra(u, init as RequestInit | undefined);
    if (handled) return handled;
    if (u === '/auth/passkeys') return makeJsonResponse({ passkeys: [] });
    if (u === '/me/approver-devices') return makeJsonResponse({ devices: [] });
    if (u === '/sso/reauth/start') return makeJsonResponse({ authUrl: AUTH_URL });
    return makeJsonResponse({});
  });
}

const callsTo = (url: string) => fetchWithAuthMock.mock.calls.filter(([u]) => String(u) === url);

function interceptNavigation() {
  const seen = { intent: 'not-called' as string | null };
  const assign = vi.fn(() => {
    seen.intent = sessionStorage.getItem(SSO_REAUTH_INTENT_KEY);
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, hash: '', search: '', pathname: '/settings/profile' },
  });
  return { assign, seen };
}

function returnFromIdp() {
  stashSsoReauthIntent('approver_device');
  window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);
}

describe('ProfilePage — approver-device SSO re-auth round-trip (#9007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
    sessionStorage.clear();
    window.history.replaceState(null, '', '/settings/profile');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
  });

  it('offers the IdP in Approval security and records approver_device before leaving', async () => {
    mockApi();
    render(<ProfilePage initialUser={PASSWORDLESS_NO_FACTOR_USER} />);

    const start = await screen.findByTestId('approver-stepup-sso-start');
    expect(screen.queryByTestId('approver-stepup-password')).toBeNull();
    expect(screen.getByTestId('approver-device-register')).toBeDisabled();
    const { assign, seen } = interceptNavigation();

    fireEvent.click(start);

    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH_URL));
    expect(seen.intent).toBe('approver_device');
    expect(callsTo('/sso/reauth/start')).toHaveLength(1);
  });

  it('returns to the register form with the grant armed, and never runs the TOTP road', async () => {
    returnFromIdp();
    mockApi();
    render(<ProfilePage initialUser={PASSWORDLESS_NO_FACTOR_USER} />);

    expect(await screen.findByTestId('approver-stepup-sso-verified')).toBeTruthy();
    expect(screen.getByTestId('approver-device-register')).not.toBeDisabled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('approver-device-register')));
    expect(window.location.hash).toBe('');
    expect(callsTo('/auth/mfa/setup')).toHaveLength(0);
  });

  it('exchanges the grant at register-grant and drops it page-wide when the exchange refuses it', async () => {
    returnFromIdp();
    mockApi((u) => (u === '/authenticator/register-grant'
      ? makeJsonResponse({
        error: 'Your identity verification has expired. Please verify with your identity provider again.',
        message: 'Your identity verification has expired. Please verify with your identity provider again.',
        code: 'enrollment_grant_expired',
        reauthUrl: '/sso/reauth/start',
      }, false, 400)
      : undefined));
    render(<ProfilePage initialUser={PASSWORDLESS_NO_FACTOR_USER} />);

    const register = await screen.findByTestId('approver-device-register');
    await waitFor(() => expect(register).not.toBeDisabled());
    // The grant is in hand, so the passkey card offers "Add" rather than the IdP.
    expect(screen.queryByTestId('passkey-sso-reauth')).toBeNull();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).not.toBeNull();

    fireEvent.click(register);

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: SSO_EXPIRED }));
    const exchange = callsTo('/authenticator/register-grant');
    expect(exchange).toHaveLength(1);
    expect(JSON.parse(String((exchange[0][1] as RequestInit).body))).toEqual({ ssoReauthGrantId: GRANT });
    expect(startRegistrationMock).not.toHaveBeenCalled();
    // Spent or dead either way: every card goes back to offering the IdP.
    expect(await screen.findByTestId('approver-stepup-sso-start')).toBeTruthy();
    expect(screen.getByTestId('passkey-sso-reauth')).toBeTruthy();
    expect(sessionStorage.getItem(SSO_REAUTH_GRANT_KEY)).toBeNull();
  });
});
