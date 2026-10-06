import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProfilePage from './ProfilePage';
import { fetchWithAuth } from '../../stores/auth';
import { SSO_REAUTH_INTENT_KEY, stashSsoReauthIntent } from '@/lib/ssoReauthIntent';

/**
 * #4045 — recovery-code rotation, MFA disable and passkey deletion were
 * dead ends for a PASSWORDLESS (SSO-provisioned) account that had enrolled a
 * factor through #4041:
 *
 *   1. recovery codes — the Regenerate button waited on a password field the
 *      account can never fill: permanently greyed, no request, no reason;
 *   2. passkey delete — the handler short-circuited on the empty (hidden)
 *      password field and asked for a password the account does not have;
 *   3. MFA disable — any string enabled the submit, which always got a generic
 *      `Invalid credentials`.
 *
 * The API now takes a fresh IdP re-auth grant (`sso_reauth_manage_factor`) in
 * place of the password for such an account. These specs pin the client half:
 * each surface offers the IdP round-trip instead of a password, records which
 * action it left from, and on return sends `ssoReauthGrantId` alongside the
 * UNCHANGED existing-factor proof.
 */

vi.mock('../../stores/auth', () => ({
  createPasskeyCredential: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn(), sessionGeneration: 0, commitReissuedSessionIfCurrent: vi.fn(() => true) }) },
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

// TicketPushoverSettings fetches /users/me/ticket-pushover on mount; stub it so
// it doesn't consume from this file's fetchWithAuth mocks. Its own behavior is
// covered by TicketPushoverSettings.test.tsx.
vi.mock('./TicketPushoverSettings', () => ({
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

const GRANT = '8a5f3c2e-1b4d-4e6f-9a0b-1c2d3e4f5a6b';
const AUTH_URL = 'https://idp.example.com/authorize?prompt=login';

const PASSWORDLESS_TOTP_USER = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: true,
  mfaMethod: 'totp' as const,
  hasPassword: false,
};

const PASSKEY = { id: 'pk-1', name: 'YubiKey', createdAt: '2026-09-01T00:00:00Z' };

const REAL_LOCATION = window.location;

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mockApi(extra: Handler = () => undefined, passkeys: unknown[] = []) {
  fetchWithAuthMock.mockImplementation(async (url, init) => {
    const u = String(url);
    const handled = extra(u, init as RequestInit | undefined);
    if (handled) return handled;
    if (u === '/auth/passkeys') return makeJsonResponse({ passkeys });
    if (u === '/sso/reauth/start') return makeJsonResponse({ authUrl: AUTH_URL });
    if (u === '/auth/mfa/step-up') return makeJsonResponse({ stepUpGrantId: 'factor-grant-1' });
    return makeJsonResponse({});
  });
}

const callsTo = (url: string) => fetchWithAuthMock.mock.calls.filter(([u]) => String(u) === url);
const bodyOf = (url: string) => {
  const call = callsTo(url).at(-1);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

/** Stub `window.location` so the IdP navigation can be observed; returns the intent recorded at that instant. */
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

function fillDigits(value: string) {
  const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"][maxlength="1"]');
  digits.forEach((input, index) => fireEvent.change(input, { target: { value: value[index] } }));
}

describe('ProfilePage — passwordless SSO factor management (#4045)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
    sessionStorage.clear();
    window.history.replaceState(null, '', '/settings/profile');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
  });

  describe('recovery-code rotation', () => {
    it('offers the IdP round-trip instead of a password field it can never fill', async () => {
      mockApi();
      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);

      fireEvent.click(await screen.findByTestId('mfa-recovery-regenerate-start'));

      expect(document.getElementById('mfa-recovery-password')).toBeNull();
      expect(screen.queryByTestId('mfa-recovery-regenerate')).toBeNull();
      expect(screen.getByTestId('mfa-recovery-sso-reauth')).toBeTruthy();
      expect(screen.getByText(/has no password\. Verify with your provider to confirm this change/i)).toBeTruthy();
    });

    it('records the recovery-codes action before leaving for the IdP', async () => {
      mockApi();
      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);
      fireEvent.click(await screen.findByTestId('mfa-recovery-regenerate-start'));
      const { assign, seen } = interceptNavigation();

      fireEvent.click(screen.getByTestId('mfa-recovery-sso-reauth'));

      await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH_URL));
      expect(seen.intent).toBe('recovery_codes');
      expect(callsTo('/sso/reauth/start')).toHaveLength(1);
    });

    it('returns to the recovery view and rotates with the grant PLUS the current MFA code', async () => {
      stashSsoReauthIntent('recovery_codes');
      window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);
      mockApi((u) => (u === '/auth/mfa/recovery-codes'
        ? makeJsonResponse({ success: true, recoveryCodes: ['AAAA-1111', 'BBBB-2222'] })
        : undefined));

      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);

      const regenerate = await screen.findByTestId('mfa-recovery-regenerate');
      expect(document.getElementById('mfa-recovery-password')).toBeNull();
      fireEvent.change(screen.getByTestId('mfa-recovery-factor-code'), { target: { value: '123456' } });
      fireEvent.click(regenerate);
      fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

      expect(await screen.findByText('AAAA-1111')).toBeTruthy();
      expect(bodyOf('/auth/mfa/step-up')).toMatchObject({ method: 'totp', code: '123456', operation: 'rotate_recovery_codes' });
      expect(bodyOf('/auth/mfa/recovery-codes')).toEqual({ ssoReauthGrantId: GRANT, stepUpGrantId: 'factor-grant-1' });
      // The management return must never run the ENROLLMENT road.
      expect(callsTo('/auth/mfa/setup')).toHaveLength(0);
    });

    it('drops a dead grant and offers the IdP again with localized copy', async () => {
      stashSsoReauthIntent('recovery_codes');
      window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);
      mockApi((u) => (u === '/auth/mfa/recovery-codes'
        ? makeJsonResponse({
          error: 'Your identity verification has expired. Please verify with your identity provider again.',
          code: 'sso_reauth_grant_expired',
          reauthUrl: '/sso/reauth/start',
        }, false, 400)
        : undefined));

      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);
      fireEvent.change(await screen.findByTestId('mfa-recovery-factor-code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
      fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

      expect(await screen.findByText(/verification has expired\. Verify again to confirm this change/i)).toBeTruthy();
      expect(screen.queryByText(/Please verify with your identity provider again/i)).toBeNull();
      expect(await screen.findByTestId('mfa-recovery-sso-reauth')).toBeTruthy();
    });
  });

  describe('MFA disable', () => {
    it('offers the IdP round-trip instead of a password that can never succeed', async () => {
      mockApi();
      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);

      fireEvent.click(await screen.findByRole('button', { name: /^Disable$/i }));

      expect(document.getElementById('mfa-disable-password')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Disable MFA$/i })).toBeNull();
      const { assign, seen } = interceptNavigation();
      fireEvent.click(screen.getByTestId('mfa-disable-sso-reauth'));

      await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH_URL));
      expect(seen.intent).toBe('disable_mfa');
    });

    it('returns to the disable view and sends the grant with the live code', async () => {
      stashSsoReauthIntent('disable_mfa');
      window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);
      mockApi((u) => (u === '/auth/mfa/disable' ? makeJsonResponse({ success: true }) : undefined));

      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);

      const submit = await screen.findByRole('button', { name: /^Disable MFA$/i });
      fillDigits('654321');
      fireEvent.click(submit);

      expect(await screen.findByText(/Multi-factor authentication disabled/i)).toBeTruthy();
      expect(bodyOf('/auth/mfa/disable')).toEqual({ code: '654321', ssoReauthGrantId: GRANT });
      expect(callsTo('/auth/mfa/setup')).toHaveLength(0);
    });
  });

  describe('passkey deletion', () => {
    it('explains and offers the IdP instead of demanding a password the account does not have', async () => {
      mockApi(undefined, [PASSKEY]);
      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);

      await screen.findByText('YubiKey');
      // The verify section explains the requirement up front...
      expect(screen.getAllByText(/Verify with your identity provider before removing a passkey/i)).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));

      // ...and pressing Delete anyway answers with the same actionable reason
      // (never a silent no-op, never a request for a password).
      await waitFor(() => {
        expect(screen.getAllByText(/Verify with your identity provider before removing a passkey/i)).toHaveLength(2);
      });
      expect(screen.queryByText(/Current password is required/i)).toBeNull();
      expect(screen.queryByTestId('passkey-delete-confirm')).toBeNull();
      expect(callsTo('/auth/passkeys/pk-1')).toHaveLength(0);

      const { assign, seen } = interceptNavigation();
      fireEvent.click(screen.getByTestId('passkey-delete-sso-reauth'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH_URL));
      expect(seen.intent).toBe('delete_passkey');
    });

    it('returns ready to delete and sends the grant alongside the delete_passkey factor grant', async () => {
      stashSsoReauthIntent('delete_passkey');
      window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);
      mockApi((u, init) => (u === '/auth/passkeys/pk-1' && init?.method === 'DELETE'
        ? makeJsonResponse({ success: true })
        : undefined), [PASSKEY]);

      render(<ProfilePage initialUser={PASSWORDLESS_TOTP_USER} />);

      expect(await screen.findByText(/Identity verified\. Choose Delete on the passkey/i)).toBeTruthy();
      expect(screen.queryByTestId('passkey-delete-sso-reauth')).toBeNull();
      fireEvent.change(screen.getByTestId('passkey-factor-code'), { target: { value: '111222' } });
      fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
      fireEvent.click(await screen.findByTestId('passkey-delete-confirm'));

      await waitFor(() => expect(callsTo('/auth/passkeys/pk-1')).toHaveLength(1));
      expect(bodyOf('/auth/mfa/step-up')).toMatchObject({ method: 'totp', code: '111222', operation: 'delete_passkey', passkeyId: 'pk-1' });
      expect(bodyOf('/auth/passkeys/pk-1')).toEqual({ ssoReauthGrantId: GRANT, stepUpGrantId: 'factor-grant-1' });
      expect(callsTo('/auth/mfa/setup')).toHaveLength(0);
    });
  });
});
