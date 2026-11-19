import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #10650 (W02 of #11420): ProfilePage wiring for an authenticator app held as
 * a BACKUP beside a primary passkey — add (confirmed by a passkey-minted
 * `add_factor` grant), remove (`POST /auth/mfa/totp/remove` with a
 * `remove_totp` grant), and the "Use authenticator app instead" alternative on
 * the step-up prompts a user who lost the passkey would otherwise be stuck on.
 */

const {
  fetchWithAuthMock,
  createPasskeyCredentialMock,
  getPasskeyCredentialMock,
  apiGetMfaEnrollmentOptionsMock,
  mintStepUpGrantMock,
  commitReissuedSessionIfCurrentMock,
  commitMfaEnrollmentIfCurrentMock,
  commitMfaStateIfCurrentMock,
  commitMfaDisableIfCurrentMock,
  updateUserMock,
  authState,
} = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
  getPasskeyCredentialMock: vi.fn(),
  apiGetMfaEnrollmentOptionsMock: vi.fn(),
  mintStepUpGrantMock: vi.fn(),
  commitReissuedSessionIfCurrentMock: vi.fn(() => true),
  commitMfaEnrollmentIfCurrentMock: vi.fn(() => true),
  commitMfaStateIfCurrentMock: vi.fn(() => true),
  commitMfaDisableIfCurrentMock: vi.fn(() => true),
  updateUserMock: vi.fn(),
  // Mutable so a test can simulate a logout/re-login between two attempts.
  authState: { sessionGeneration: 0 },
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  getPasskeyCredential: getPasskeyCredentialMock,
  apiGetMfaEnrollmentOptions: apiGetMfaEnrollmentOptionsMock,
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    {
      getState: () => ({
        updateUser: updateUserMock,
        sessionGeneration: authState.sessionGeneration,
        user: { id: 'user-1' },
        commitReissuedSessionIfCurrent: commitReissuedSessionIfCurrentMock,
        commitMfaEnrollmentIfCurrent: commitMfaEnrollmentIfCurrentMock,
        commitMfaStateIfCurrent: commitMfaStateIfCurrentMock,
        commitMfaDisableIfCurrent: commitMfaDisableIfCurrentMock,
      }),
    },
  ),
}));

vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintStepUpGrantMock,
  StepUpMintError: class StepUpMintError extends Error {
    constructor(readonly code: string, message: string, readonly status?: number, readonly responseCode?: string) {
      super(message);
      this.name = 'StepUpMintError';
    }
  },
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/avatarBlobCache', () => ({ useAvatarBlobUrl: (url: string | null | undefined) => url ?? null }));
vi.mock('./ApproverDevicesSection', () => ({ default: () => null }));
vi.mock('./TicketPushoverSettings', () => ({ default: () => null }));
vi.mock('./EmailNotificationSettings', () => ({ default: () => null }));
vi.mock('./ConnectSsoCard', () => ({ default: () => null }));

import ProfilePage from './ProfilePage';
import { StepUpMintError } from '../../lib/mfaStepUp';
import { stashSsoReauthIntent } from '@/lib/ssoReauthIntent';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const TOKENS = { accessToken: 'replacement-access', expiresInSeconds: 900 };
const PASSKEY = { id: '70000000-0000-4000-8000-000000000001', name: 'YubiKey', lastUsedAt: null };
const GRANT = '11111111-2222-4333-8444-555555555555';

const PASSKEY_PRIMARY = {
  id: 'user-1',
  name: 'Casey Admin',
  email: 'casey@example.com',
  mfaEnabled: true,
  mfaMethod: 'passkey' as const,
  hasPassword: true,
  totpEnrolled: false,
};
const PASSKEY_WITH_BACKUP = { ...PASSKEY_PRIMARY, totpEnrolled: true };
const TOTP_PRIMARY = { ...PASSKEY_PRIMARY, mfaMethod: 'totp' as const, totpEnrolled: true };

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mockApi(extra: Handler = () => undefined, passkeys: unknown[] = [PASSKEY]) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const handled = extra(u, init);
    if (handled) return handled;
    if (u === '/auth/passkeys') return makeJsonResponse({ passkeys });
    if (u === '/auth/mfa/setup') return makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,abc', secret: 'JBSWY3DPEHPK3PXP' });
    if (u === '/auth/mfa/step-up') return makeJsonResponse({ stepUpGrantId: 'factor-grant-1' });
    if (u === '/auth/mfa/step-up/options') return makeJsonResponse({ options: { challenge: 'c' } });
    return makeJsonResponse({});
  });
}

const callsTo = (url: string) => fetchWithAuthMock.mock.calls.filter(([u]) => String(u) === url);
const bodyOf = (url: string, index = -1) => {
  const call = callsTo(url).at(index);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

function fillDigits(value: string) {
  const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"][maxlength="1"]');
  expect(digits.length).toBe(6);
  digits.forEach((input, index) => fireEvent.change(input, { target: { value: value[index] } }));
}

const status = () => screen.getByTestId('mfa-authenticator-status').textContent;

async function openBackupQr() {
  fireEvent.click(await screen.findByTestId('mfa-totp-backup-start'));
  fireEvent.change(screen.getByTestId('mfa-current-password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText(/Set up authenticator/i);
}

const REAL_LOCATION = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  authState.sessionGeneration = 0;
  commitReissuedSessionIfCurrentMock.mockReturnValue(true);
  commitMfaStateIfCurrentMock.mockReturnValue(true);
  commitMfaEnrollmentIfCurrentMock.mockReturnValue(true);
  apiGetMfaEnrollmentOptionsMock.mockResolvedValue({
    success: true,
    options: { allowedMethods: { totp: true, sms: false, passkey: true }, phoneConfigured: false },
  });
  Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
  sessionStorage.clear();
  window.history.replaceState(null, '', '/settings/profile');
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
});

describe('ProfilePage — adding the authenticator backup', () => {
  it('mints add_factor with a passkey, posts /mfa/enable with it, and keeps the passkey primary', async () => {
    mockApi((u) => (u === '/auth/mfa/enable'
      ? makeJsonResponse({ success: true, backup: true, message: 'ignored server copy', tokens: TOKENS })
      : undefined));
    mintStepUpGrantMock.mockImplementation(async () => {
      // The grant must exist BEFORE the confirm request goes out.
      expect(callsTo('/auth/mfa/enable')).toHaveLength(0);
      return 'add-factor-grant';
    });

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    expect(await screen.findByText("Authenticator app added as a backup. Your recovery codes haven't changed")).toBeTruthy();
    expect(mintStepUpGrantMock).toHaveBeenCalledWith({ operation: 'add_factor', reauth: { method: 'passkey' } });
    expect(bodyOf('/auth/mfa/enable')).toEqual({ code: '123456', currentPassword: 'pw', stepUpGrantId: 'add-factor-grant' });
    expect(commitReissuedSessionIfCurrentMock).toHaveBeenCalledWith(0, TOKENS);
    // The initial-enrollment commit would flip the primary to TOTP.
    expect(commitMfaEnrollmentIfCurrentMock).not.toHaveBeenCalled();
    expect(updateUserMock).toHaveBeenCalledWith({ totpEnrolled: true });
    expect(status()).toBe('Backup');
    expect(screen.queryByRole('dialog', { name: 'Save your recovery codes' })).toBeNull();
  });

  it('a cancelled passkey prompt sends nothing and keeps the code view open', async () => {
    mockApi();
    mintStepUpGrantMock.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    expect(await screen.findByText('Passkey confirmation was canceled or timed out.')).toBeTruthy();
    expect(callsTo('/auth/mfa/enable')).toHaveLength(0);
    expect(screen.getByText(/Set up authenticator/i)).toBeTruthy();
    const digits = Array.from(document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"][maxlength="1"]'));
    expect(digits.map((d) => d.value).join('')).toBe('123456');
  });

  it('reuses an unspent grant after a mistyped code instead of asking for the passkey again', async () => {
    let enableCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/enable') return undefined;
      enableCalls += 1;
      return enableCalls === 1
        ? makeJsonResponse({ error: 'Invalid MFA code', message: 'Invalid MFA code', code: 'mfa_code_invalid' }, false, 400)
        : makeJsonResponse({ success: true, backup: true, tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));
    await screen.findByText(/Invalid MFA code/i);
    fillDigits('222222');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await screen.findByText("Authenticator app added as a backup. Your recovery codes haven't changed");
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(1);
    expect(bodyOf('/auth/mfa/enable', 1)).toMatchObject({ code: '222222', stepUpGrantId: 'grant-a' });
  });

  it('drops a grant the server reports as spent, so the retry mints a fresh one', async () => {
    let enableCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/enable') return undefined;
      enableCalls += 1;
      // W01's issuance-admission refusal after the grant was spent.
      return enableCalls === 1
        ? makeJsonResponse({ error: 'Authentication issuance unavailable', stepUpGrantConsumed: true }, false, 409)
        : makeJsonResponse({ success: true, backup: true, tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a').mockResolvedValueOnce('grant-b');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));
    await screen.findByText('Authentication issuance unavailable');
    fillDigits('222222');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await screen.findByText("Authenticator app added as a backup. Your recovery codes haven't changed");
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(2);
    expect(bodyOf('/auth/mfa/enable', 1)).toMatchObject({ stepUpGrantId: 'grant-b' });
  });

  it('reads the policy once: "Not available" when authenticator apps are disallowed', async () => {
    apiGetMfaEnrollmentOptionsMock.mockResolvedValue({
      success: true,
      options: { allowedMethods: { totp: false, sms: false, passkey: true }, phoneConfigured: false },
    });
    mockApi();

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);

    await waitFor(() => expect(status()).toBe('Not available'));
    expect(screen.queryByTestId('mfa-totp-backup-start')).toBeNull();
    expect(apiGetMfaEnrollmentOptionsMock).toHaveBeenCalledTimes(1);
  });

  it('offers the backup when the policy cannot be read (the server answers)', async () => {
    apiGetMfaEnrollmentOptionsMock.mockResolvedValue({ success: false, error: 'Network error' });
    mockApi();

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);

    await waitFor(() => expect(apiGetMfaEnrollmentOptionsMock).toHaveBeenCalled());
    expect(screen.getByTestId('mfa-totp-backup-start')).toBeTruthy();
  });

  it('does not read the policy for an account that already has the authenticator', async () => {
    mockApi();

    render(<ProfilePage initialUser={TOTP_PRIMARY} />);
    await screen.findByText('YubiKey');

    expect(apiGetMfaEnrollmentOptionsMock).not.toHaveBeenCalled();
  });
});

describe('ProfilePage — removing the authenticator app', () => {
  it('removes the backup with a remove_totp passkey grant and the password', async () => {
    mockApi((u) => (u === '/auth/mfa/totp/remove'
      ? makeJsonResponse({ success: true, mfaMethod: 'passkey', tokens: TOKENS })
      : undefined));
    mintStepUpGrantMock.mockResolvedValueOnce('remove-grant');

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    fireEvent.click(await screen.findByTestId('mfa-totp-backup-remove-start'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    expect(await screen.findByText("Authenticator app removed. You'll sign in with your passkey")).toBeTruthy();
    expect(mintStepUpGrantMock).toHaveBeenCalledWith({ operation: 'remove_totp', reauth: { method: 'passkey' } });
    expect(bodyOf('/auth/mfa/totp/remove')).toEqual({ currentPassword: 'pw', stepUpGrantId: 'remove-grant' });
    expect(commitMfaStateIfCurrentMock).toHaveBeenCalledWith(0, { mfaEnabled: true, mfaMethod: 'passkey' }, TOKENS);
    expect(updateUserMock).toHaveBeenCalledWith({ totpEnrolled: false });
    expect(status()).toBe('Not set up');
  });

  it('a TOTP primary with passkeys removes with a code and applies the promoted method', async () => {
    mockApi((u) => (u === '/auth/mfa/totp/remove'
      ? makeJsonResponse({ success: true, mfaMethod: 'passkey', tokens: TOKENS })
      : undefined));
    mintStepUpGrantMock.mockResolvedValueOnce('remove-grant');

    render(<ProfilePage initialUser={TOTP_PRIMARY} />);
    fireEvent.click(await screen.findByTestId('mfa-totp-remove-start'));
    expect(screen.queryByRole('button', { name: 'Disable MFA' })).toBeNull();
    fireEvent.click(screen.getByTestId('mfa-totp-remove-use-code'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    await screen.findByText("Authenticator app removed. You'll sign in with your passkey");
    expect(mintStepUpGrantMock).toHaveBeenCalledWith({ operation: 'remove_totp', reauth: { method: 'totp', code: '123456' } });
    expect(commitMfaStateIfCurrentMock).toHaveBeenCalledWith(0, { mfaEnabled: true, mfaMethod: 'passkey' }, TOKENS);
    expect(callsTo('/auth/mfa/disable')).toHaveLength(0);
    // The promoted passkey primary now offers the backup again.
    await waitFor(() => expect(status()).toBe('Not set up'));
  });

  it('tells the user to wait for the next code when the authenticator code is refused', async () => {
    mockApi();
    mintStepUpGrantMock.mockRejectedValueOnce(new StepUpMintError('invalid_factor', 'Invalid MFA code', 400, 'mfa_proof_invalid'));

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    fireEvent.click(await screen.findByTestId('mfa-totp-backup-remove-start'));
    fireEvent.click(screen.getByTestId('mfa-totp-remove-use-code'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    expect(await screen.findByText(/wait for the next code from your authenticator app/i)).toBeTruthy();
    expect(callsTo('/auth/mfa/totp/remove')).toHaveLength(0);
  });

  it('keeps an unspent remove grant for the retry after a mistyped password', async () => {
    let removeCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/totp/remove') return undefined;
      removeCalls += 1;
      return removeCalls === 1
        ? makeJsonResponse({ error: 'Invalid credentials', code: 'invalid_credentials' }, false, 400)
        : makeJsonResponse({ success: true, mfaMethod: 'passkey', tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('remove-grant');

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    fireEvent.click(await screen.findByTestId('mfa-totp-backup-remove-start'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));
    await screen.findByText('Invalid credentials');
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    await screen.findByText("Authenticator app removed. You'll sign in with your passkey");
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(1);
    expect(bodyOf('/auth/mfa/totp/remove', 1)).toEqual({ currentPassword: 'pw', stepUpGrantId: 'remove-grant' });
  });

  it('shows the server message when /mfa/disable refuses while passkeys survive', async () => {
    mockApi((u) => (u === '/auth/mfa/disable'
      ? makeJsonResponse({
        error: 'Remove your passkeys first, or remove this sign-in method on its own.',
        code: 'factor_removal_required',
      }, false, 409)
      : undefined), []);

    render(<ProfilePage initialUser={TOTP_PRIMARY} />);
    await screen.findByText(/No passkeys are registered/i);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    fillDigits('123456');
    fireEvent.change(screen.getByLabelText('Current password', { selector: '#mfa-disable-password' }), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disable MFA' }));

    expect(await screen.findByText('Remove your passkeys first, or remove this sign-in method on its own.')).toBeTruthy();
  });

  it('routes a passwordless IdP return with the remove intent back to the remove view', async () => {
    stashSsoReauthIntent('remove_totp');
    window.history.replaceState(null, '', `/settings/profile#ssoReauthGrant=${GRANT}`);
    mockApi((u) => (u === '/auth/mfa/totp/remove'
      ? makeJsonResponse({ success: true, mfaMethod: 'passkey', tokens: TOKENS })
      : undefined));
    mintStepUpGrantMock.mockResolvedValueOnce('remove-grant');

    render(<ProfilePage initialUser={{ ...PASSKEY_WITH_BACKUP, hasPassword: false }} />);

    fireEvent.click(await screen.findByTestId('mfa-totp-remove-submit'));
    await screen.findByText("Authenticator app removed. You'll sign in with your passkey");
    expect(bodyOf('/auth/mfa/totp/remove')).toEqual({ ssoReauthGrantId: GRANT, stepUpGrantId: 'remove-grant' });
    expect(callsTo('/auth/mfa/setup')).toHaveLength(0);
  });
});

describe('ProfilePage — "Use authenticator app instead" on step-up prompts', () => {
  it('deletes a passkey with an authenticator code', async () => {
    mockApi((u) => (u === `/auth/passkeys/${PASSKEY.id}`
      ? makeJsonResponse({ success: true, mfaEnabled: true, mfaMethod: 'passkey', tokens: TOKENS })
      : undefined));

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    await screen.findByText('YubiKey');
    fireEvent.click(screen.getByTestId('passkey-delete'));
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('passkey-delete-use-totp'));
    fireEvent.change(screen.getByTestId('passkey-factor-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('passkey-delete-confirm'));

    await screen.findByText('Passkey deleted');
    expect(bodyOf('/auth/mfa/step-up')).toEqual({ method: 'totp', code: '123456', operation: 'delete_passkey', passkeyId: PASSKEY.id });
    expect(getPasskeyCredentialMock).not.toHaveBeenCalled();
    expect(callsTo('/auth/mfa/step-up/options')).toHaveLength(0);
  });

  it('shows the wait-for-next-code hint when the delete step-up refuses the code', async () => {
    mockApi((u) => (u === '/auth/mfa/step-up'
      ? makeJsonResponse({ error: 'Invalid MFA code', code: 'mfa_proof_invalid' }, false, 400)
      : undefined));

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    await screen.findByText('YubiKey');
    fireEvent.click(screen.getByTestId('passkey-delete'));
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('passkey-delete-use-totp'));
    fireEvent.change(screen.getByTestId('passkey-factor-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('passkey-delete-confirm'));

    expect(await screen.findByText(/wait for the next code from your authenticator app/i)).toBeTruthy();
  });

  it('offers no authenticator alternative to a passkey-only account', async () => {
    mockApi();

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await screen.findByText('YubiKey');
    fireEvent.click(screen.getByTestId('passkey-delete'));

    expect(screen.queryByTestId('passkey-delete-use-totp')).toBeNull();
  });

  it('adds a passkey proving the existing factor with an authenticator code', async () => {
    let optionsCalls = 0;
    mockApi((u) => {
      if (u === '/auth/passkeys/register/options') {
        optionsCalls += 1;
        return optionsCalls === 1
          ? makeJsonResponse({ error: 'existing_factor_step_up_required' }, false, 403)
          : makeJsonResponse({ options: { challenge: 'reg' } });
      }
      if (u === '/auth/passkeys/register/verify') {
        return makeJsonResponse({ passkey: { id: 'pk-2', name: 'Laptop' }, mfaEnabled: true, mfaMethod: 'passkey', tokens: TOKENS });
      }
      return undefined;
    });
    createPasskeyCredentialMock.mockResolvedValueOnce({ id: 'cred' });
    mintStepUpGrantMock.mockResolvedValueOnce('add-grant');

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    await screen.findByText('YubiKey');
    fireEvent.click(screen.getByTestId('passkey-add'));
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('passkey-add-confirm'));

    expect(await screen.findByTestId('passkey-stepup-passkey-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('passkey-stepup-use-totp'));
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('passkey-add-confirm'));

    await screen.findByText('Passkey added');
    expect(mintStepUpGrantMock).toHaveBeenCalledWith({ operation: 'add_factor', reauth: { method: 'totp', code: '123456' } });
  });

  it('rotates recovery codes proving with the authenticator instead of the passkey', async () => {
    mockApi((u) => (u === '/auth/mfa/recovery-codes'
      ? makeJsonResponse({ success: true, recoveryCodes: ['AAAA-1111', 'BBBB-2222'], tokens: TOKENS })
      : undefined));

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    fireEvent.click(await screen.findByTestId('mfa-recovery-regenerate-start'));
    fireEvent.click(screen.getByTestId('mfa-recovery-use-totp'));
    fireEvent.change(screen.getByTestId('mfa-recovery-factor-code'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('Current password', { selector: '#mfa-recovery-password' }), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
    fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

    expect(await screen.findByText('AAAA-1111')).toBeTruthy();
    expect(bodyOf('/auth/mfa/step-up')).toEqual({ method: 'totp', code: '123456', operation: 'rotate_recovery_codes' });
    expect(callsTo('/auth/mfa/step-up/options')).toHaveLength(0);
    expect(getPasskeyCredentialMock).not.toHaveBeenCalled();
  });
});

describe('ProfilePage — review hardening (#11486)', () => {
  it('leaves the initial TOTP enrollment road untouched: no step-up, codes shown, primary becomes TOTP', async () => {
    mockApi((u) => (u === '/auth/mfa/enable'
      ? makeJsonResponse({ success: true, recoveryCodes: ['AAAA-1111', 'BBBB-2222'], tokens: TOKENS })
      : undefined), []);

    render(<ProfilePage initialUser={{ ...PASSKEY_PRIMARY, mfaEnabled: false, mfaMethod: null }} />);
    fireEvent.click(await screen.findByTestId('mfa-setup-start'));
    fireEvent.change(screen.getByTestId('mfa-current-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(/Set up authenticator/i);
    fillDigits('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enable' }));

    expect(await screen.findByText('AAAA-1111')).toBeTruthy();
    expect(mintStepUpGrantMock).not.toHaveBeenCalled();
    expect(bodyOf('/auth/mfa/enable')).toEqual({ code: '123456', currentPassword: 'pw' });
    expect(commitMfaEnrollmentIfCurrentMock).toHaveBeenCalledWith(0, 'totp', TOKENS);
    expect(commitReissuedSessionIfCurrentMock).not.toHaveBeenCalled();
    expect(apiGetMfaEnrollmentOptionsMock).not.toHaveBeenCalled();
  });

  it('a grant refused as stale on /mfa/enable is dropped, says so, and the retry mints again', async () => {
    let enableCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/enable') return undefined;
      enableCalls += 1;
      return enableCalls === 1
        ? makeJsonResponse({ error: 'existing_factor_step_up_required' }, false, 403)
        : makeJsonResponse({ success: true, backup: true, tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a').mockResolvedValueOnce('grant-b');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));
    expect(await screen.findByText('Verification expired. Please verify again.')).toBeTruthy();
    expect(screen.queryByText('existing_factor_step_up_required')).toBeNull();
    fillDigits('222222');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await screen.findByText("Authenticator app added as a backup. Your recovery codes haven't changed");
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(2);
    expect(bodyOf('/auth/mfa/enable', 1)).toMatchObject({ stepUpGrantId: 'grant-b' });
  });

  it('does not reuse a grant across a re-login (session generation moved)', async () => {
    let enableCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/enable') return undefined;
      enableCalls += 1;
      return enableCalls === 1
        ? makeJsonResponse({ error: 'Invalid MFA code', code: 'mfa_code_invalid' }, false, 400)
        : makeJsonResponse({ success: true, backup: true, tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a').mockResolvedValueOnce('grant-b');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));
    await screen.findByText(/Invalid MFA code/i);
    authState.sessionGeneration = 1;
    fillDigits('222222');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await screen.findByText(/Authenticator app added as a backup/);
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(2);
    expect(bodyOf('/auth/mfa/enable', 1)).toMatchObject({ stepUpGrantId: 'grant-b' });
  });

  it('does not reuse a grant older than its server lifetime', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let enableCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/enable') return undefined;
      enableCalls += 1;
      return enableCalls === 1
        ? makeJsonResponse({ error: 'Invalid MFA code', code: 'mfa_code_invalid' }, false, 400)
        : makeJsonResponse({ success: true, backup: true, tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a').mockResolvedValueOnce('grant-b');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));
    await screen.findByText(/Invalid MFA code/i);
    now += 5 * 60 * 1000;
    fillDigits('222222');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await screen.findByText(/Authenticator app added as a backup/);
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a grant after a server error (it may have been spent)', async () => {
    let enableCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/enable') return undefined;
      enableCalls += 1;
      return enableCalls === 1
        ? makeJsonResponse({ error: 'Internal Server Error' }, false, 500)
        : makeJsonResponse({ success: true, backup: true, tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a').mockResolvedValueOnce('grant-b');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));
    await screen.findByText(/Internal Server Error/);
    fillDigits('222222');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await screen.findByText(/Authenticator app added as a backup/);
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(2);
  });

  it('returns to the status card when the factors changed mid-flight (the staged QR is dead)', async () => {
    mockApi((u) => (u === '/auth/mfa/enable'
      ? makeJsonResponse({
        error: 'Your sign-in methods changed while this was in progress. Please start again.',
        code: 'factor_state_changed',
        stepUpGrantConsumed: false,
      }, false, 409)
      : undefined));
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    expect(await screen.findByText(/Your sign-in methods changed/)).toBeTruthy();
    expect(screen.getByTestId('mfa-authenticator-row')).toBeTruthy();
    expect(screen.queryByText(/Set up authenticator/i)).toBeNull();
    expect(screen.queryByTestId('mfa-code-rejected-hint')).toBeNull();
  });

  it('says the passkey could not be verified (not "incorrect code") when the assertion is refused', async () => {
    mockApi();
    mintStepUpGrantMock.mockRejectedValueOnce(new StepUpMintError('invalid_factor', 'Invalid passkey', 400, 'mfa_proof_invalid'));

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    expect(await screen.findByText("Your passkey couldn't be verified. Please try again.")).toBeTruthy();
    expect(screen.queryByText('Incorrect code. Please try again.')).toBeNull();
    expect(callsTo('/auth/mfa/enable')).toHaveLength(0);
  });

  it('a spent remove grant is dropped and the retry mints a fresh one', async () => {
    let removeCalls = 0;
    mockApi((u) => {
      if (u !== '/auth/mfa/totp/remove') return undefined;
      removeCalls += 1;
      return removeCalls === 1
        ? makeJsonResponse({
          error: 'Your sign-in methods changed while this was in progress. Please start again.',
          code: 'factor_state_changed',
          stepUpGrantConsumed: true,
        }, false, 409)
        : makeJsonResponse({ success: true, mfaMethod: 'passkey', tokens: TOKENS });
    });
    mintStepUpGrantMock.mockResolvedValueOnce('remove-a').mockResolvedValueOnce('remove-b');

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    fireEvent.click(await screen.findByTestId('mfa-totp-backup-remove-start'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));
    await screen.findByText(/Your sign-in methods changed/);
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    await screen.findByText("Authenticator app removed. You'll sign in with your passkey");
    expect(mintStepUpGrantMock).toHaveBeenCalledTimes(2);
    expect(bodyOf('/auth/mfa/totp/remove', 1)).toMatchObject({ stepUpGrantId: 'remove-b' });
  });

  it('a cancelled passkey prompt on remove keeps the view and the typed password', async () => {
    mockApi();
    mintStepUpGrantMock.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    fireEvent.click(await screen.findByTestId('mfa-totp-backup-remove-start'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    expect(await screen.findByText('Passkey confirmation was canceled or timed out.')).toBeTruthy();
    expect(callsTo('/auth/mfa/totp/remove')).toHaveLength(0);
    expect((screen.getByTestId('mfa-totp-remove-password') as HTMLInputElement).value).toBe('pw');
  });

  it('corrects a stale "Backup" row when the server says no authenticator is enrolled', async () => {
    mockApi((u) => (u === '/auth/mfa/totp/remove'
      ? makeJsonResponse({ error: 'No authenticator app is set up on this account', code: 'totp_not_enrolled' }, false, 400)
      : undefined));
    mintStepUpGrantMock.mockResolvedValueOnce('remove-grant');

    render(<ProfilePage initialUser={PASSKEY_WITH_BACKUP} />);
    fireEvent.click(await screen.findByTestId('mfa-totp-backup-remove-start'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    expect(await screen.findByText('No authenticator app is set up on this account')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(status()).toBe('Not set up');
  });

  it('asks the user to sign in again when the backup add could not hand back a session', async () => {
    mockApi((u) => (u === '/auth/mfa/enable'
      ? makeJsonResponse({ success: true, backup: true })
      : undefined));
    mintStepUpGrantMock.mockResolvedValueOnce('grant-a');

    render(<ProfilePage initialUser={PASSKEY_PRIMARY} />);
    await openBackupQr();
    fillDigits('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    expect(await screen.findByText("Authenticator app added as a backup. Your recovery codes haven't changed. Sign in again to continue.")).toBeTruthy();
    expect(commitReissuedSessionIfCurrentMock).not.toHaveBeenCalled();
  });
});
