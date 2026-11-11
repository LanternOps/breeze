import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApproverDevice } from '../../stores/authenticator';

const {
  listApproverDevicesMock,
  registerApproverDeviceMock,
  revokeApproverDeviceMock,
  renameApproverDeviceMock,
  showToastMock,
} = vi.hoisted(() => ({
  listApproverDevicesMock: vi.fn(),
  registerApproverDeviceMock: vi.fn(),
  revokeApproverDeviceMock: vi.fn(),
  renameApproverDeviceMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../../stores/authenticator', () => ({
  listApproverDevices: listApproverDevicesMock,
  registerApproverDevice: registerApproverDeviceMock,
  revokeApproverDevice: revokeApproverDeviceMock,
  renameApproverDevice: renameApproverDeviceMock,
}));

vi.mock('../shared/Toast', () => ({
  showToast: showToastMock,
}));

import ApproverDevicesSection from './ApproverDevicesSection';

const okResponse = (): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ success: true }) }) as unknown as Response;

const deviceFixture = (over: Partial<ApproverDevice> = {}): ApproverDevice => ({
  id: 'dev-1',
  label: 'Front-desk laptop',
  kind: 'platform',
  isPlatformBound: true,
  platformBoundBasis: 'webauthn_backup_flags',
  createdAt: '2026-06-01T12:00:00.000Z',
  lastUsedAt: '2026-06-10T09:00:00.000Z',
  disabledAt: null,
  ...over,
});

describe('ApproverDevicesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listApproverDevicesMock.mockResolvedValue([deviceFixture()]);
    registerApproverDeviceMock.mockResolvedValue(undefined);
    revokeApproverDeviceMock.mockResolvedValue(okResponse());
    renameApproverDeviceMock.mockResolvedValue(okResponse());
  });

  it('lists approver devices with label, platform-bound badge, and dates', async () => {
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const row = await screen.findByTestId('approver-device-dev-1');
    expect(row).toBeTruthy();
    expect(screen.getByTestId('approver-device-label-dev-1').textContent).toContain('Front-desk laptop');
    expect(screen.getByTestId('approver-device-platform-badge-dev-1')).toBeTruthy();
    expect(listApproverDevicesMock).toHaveBeenCalledTimes(1);
  });

  it('shows "Hardware-attested" for a device with a basis in the L4 trusted set (#5162)', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([
      deviceFixture({ platformBoundBasis: 'ios_se_p256_app_attest' }),
    ]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const badge = await screen.findByTestId('approver-device-platform-badge-dev-1');
    expect(badge.textContent).toBe('Hardware-attested');
  });

  it('shows a neutral "Not attested" badge with a tooltip for a legacy_unattested basis (#5162)', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([
      deviceFixture({ isPlatformBound: true, platformBoundBasis: 'legacy_unattested' }),
    ]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const badge = await screen.findByTestId('approver-device-platform-badge-dev-1');
    expect(badge.textContent).toBe('Not attested');
    expect(badge.getAttribute('title')).toBe(
      "Critical approvals aren't available from this device until it's re-registered on an attested app build.",
    );
  });

  it('shows "Not attested" for an unattested basis, not the honest-but-confusing raw boolean (#5162)', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([
      deviceFixture({ isPlatformBound: false, platformBoundBasis: 'unattested' }),
    ]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const badge = await screen.findByTestId('approver-device-platform-badge-dev-1');
    expect(badge.textContent).toBe('Not attested');
  });

  // ios_keychain_rsa_app_attest textually resembles the trusted
  // ios_se_p256_app_attest and is EXPLICITLY excluded from the L4-trusted set
  // server-side (authenticatorAssurance.ts) because App Attest there vouches
  // for the app instance, not that the RSA key itself lives in hardware. It's
  // exactly the value most likely to be miscopied into the mirrored web set by
  // a future edit, so pin it here.
  it('shows "Not attested" for ios_keychain_rsa_app_attest, not the similarly-named trusted basis (#5162)', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([
      deviceFixture({ isPlatformBound: true, platformBoundBasis: 'ios_keychain_rsa_app_attest' }),
    ]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const badge = await screen.findByTestId('approver-device-platform-badge-dev-1');
    expect(badge.textContent).toBe('Not attested');
  });

  // A device from an API predating #1374 W02 sends no `platformBoundBasis` at
  // all. Fail toward the honest badge, never the reverse.
  it('shows "Not attested" when platformBoundBasis is missing entirely (#5162)', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([
      deviceFixture({ isPlatformBound: true, platformBoundBasis: undefined }),
    ]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const badge = await screen.findByTestId('approver-device-platform-badge-dev-1');
    expect(badge.textContent).toBe('Not attested');
  });

  it('shows an empty state when no devices are registered', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    expect(await screen.findByTestId('approver-devices-empty')).toBeTruthy();
  });

  it('registers this device via registerApproverDevice (passkey tier) and reloads the list', async () => {
    render(<ApproverDevicesSection passkeyCount={1} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(registerApproverDeviceMock).toHaveBeenCalledWith('My workstation', { method: 'passkey' }),
    );
    // List is reloaded after a successful registration.
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });

  it('registers via password re-auth when the user has no passkey/TOTP', async () => {
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    // Submit is disabled until a password is entered.
    expect(screen.getByTestId('approver-device-register')).toBeDisabled();

    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'hunter2' },
    });
    expect(screen.getByTestId('approver-device-register')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(registerApproverDeviceMock).toHaveBeenCalledWith('This device', {
        method: 'password',
        password: 'hunter2',
      }),
    );
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });

  it('shows an incorrect-password error and preserves the label on a 400 invalid_credentials', async () => {
    // #9007 PR 1: POST /authenticator/register-grant answers a rejected
    // password with 400 + `code: 'invalid_credentials'` (#4470 shape).
    const err = Object.assign(new Error('Invalid credentials'), { status: 400, code: 'invalid_credentials' });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' }));
    expect((screen.getByTestId('approver-device-label-input') as HTMLInputElement).value).toBe('My workstation');
  });

  // #4470: the TOTP/passkey tiers mint through POST /auth/mfa/step-up, which
  // now rejects a bad proof with 400 + `code: 'mfa_proof_invalid'` instead of
  // a 401. Without a branch on the code this would fall through to the raw
  // server string and lose the tier-specific copy.
  it.each([
    ['totp' as const, 'mfa_proof_invalid', 'Incorrect code.'],
    ['password' as const, 'invalid_credentials', 'Incorrect password.'],
  ])('maps the #4470 400 proof rejection for the %s tier', async (tier, code, expected) => {
    const err = Object.assign(new Error('Invalid credentials'), { status: 400, code });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={tier === 'totp' ? 'totp' : null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(
      screen.getByTestId(tier === 'totp' ? 'approver-stepup-code' : 'approver-stepup-password'),
      { target: { value: tier === 'totp' ? '123456' : 'wrong' } },
    );
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: expected }));
    expect(showToastMock).not.toHaveBeenCalledWith({
      type: 'error',
      message: 'Session expired — reload the page and try again.',
    });
  });

  it('shows a session-expired error (not "Incorrect password") on a 401 whose message is NOT the credential-failure string', async () => {
    // A rejected bearer token (auth middleware) also 401s, but with a message
    // like "Invalid or expired token" rather than the literal "Invalid
    // credentials" the credential-check handlers return. Because the mint
    // calls use `skipUnauthorizedRetry`, this must not be mislabeled as a
    // wrong password.
    const err = Object.assign(new Error('Invalid or expired token'), { status: 401 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({
        type: 'error',
        message: 'Session expired — reload the page and try again.',
      }),
    );
    expect(showToastMock).not.toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' });
  });

  it('clears the re-auth value but keeps the label on a 403 (grant expired)', async () => {
    const err = Object.assign(new Error('Grant expired.'), { status: 403 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Verification expired — please verify again.' }),
    );
    expect((screen.getByTestId('approver-device-label-input') as HTMLInputElement).value).toBe('My workstation');
    expect((screen.getByTestId('approver-stepup-password') as HTMLInputElement).value).toBe('');
  });

  it('shows a passkey-specific error (not "Incorrect password") on a rejected proof in the passkey tier', async () => {
    const err = Object.assign(new Error('Invalid credentials'), { status: 400, code: 'mfa_proof_invalid' });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={1} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Passkey verification failed — try again.' }),
    );
    expect(showToastMock).not.toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' });
  });

  it.each(['NotAllowedError', 'AbortError'])(
    'shows a cancellation message (not raw DOMException text) when the WebAuthn ceremony rejects with %s',
    async (name) => {
      const domException = Object.assign(new Error('The operation either timed out or was not allowed.'), { name });
      registerApproverDeviceMock.mockRejectedValueOnce(domException);
      render(<ApproverDevicesSection passkeyCount={1} mfaMethod={null} />);
      await screen.findByTestId('approver-device-dev-1');

      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Registration was cancelled.' }),
      );
      expect(showToastMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('operation either timed out') }),
      );
    },
  );

  it('shows stronger-factor guidance on a 403 whose message is stronger_factor_required', async () => {
    const err = Object.assign(new Error('stronger_factor_required'), { status: 403 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({
        type: 'error',
        message: 'Use your passkey or authenticator code instead — reload the page to update your options.',
      }),
    );
  });

  it('lists a registered mobile_hw_key phone alongside the register-this-browser action', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([
      deviceFixture({
        id: 'd1',
        kind: 'mobile_hw_key',
        label: 'iPhone 16 Pro',
        isPlatformBound: true,
        lastUsedAt: null,
      }),
    ]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    await waitFor(() => screen.getByText('iPhone 16 Pro'));
    expect(screen.getByTestId('approver-device-d1')).toBeTruthy();
    // A device that has never been used yet (lastUsedAt === null) shows the
    // pending badge until it completes its first approval.
    expect(screen.getByTestId('approver-device-pending-d1')).toBeTruthy();
    // The browser-registration affordance is reframed as an additive, optional
    // path below the list (not the only way to get an approver device).
    expect(screen.getByRole('heading', { name: /register this browser/i })).toBeTruthy();
  });

  it('points unregistered users to the mobile app in the empty state', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const empty = await screen.findByTestId('approver-devices-empty');
    expect(empty.textContent).toMatch(/mobile app/i);
  });

  // #9007: the legacy "401 + literal 'Invalid credentials'" arm is gone with
  // the route's move to 400. A 401 is the bearer, whatever its message.
  it('treats any 401 as a dead session, even one whose message reads "Invalid credentials"', async () => {
    const err = Object.assign(new Error('Invalid credentials'), { status: 401 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-stepup-password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({
        type: 'error',
        message: 'Session expired — reload the page and try again.',
      }),
    );
    expect(showToastMock).not.toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' });
  });

  describe('passwordless account: SSO re-auth road (#9007)', () => {
    const SSO_EXPIRED = 'Your identity provider verification has expired or was already used. Verify again to register this device.';

    it('offers the IdP round-trip, keeps Register disabled, and starts the trip on click', async () => {
      const onStartSsoReauth = vi.fn();
      render(
        <ApproverDevicesSection
          passkeyCount={0}
          mfaMethod={null}
          hasPassword={false}
          ssoReauthGrantId={null}
          onStartSsoReauth={onStartSsoReauth}
        />,
      );
      await screen.findByTestId('approver-device-dev-1');

      expect(screen.queryByTestId('approver-stepup-password')).toBeNull();
      expect(screen.getByTestId('approver-device-register')).toBeDisabled();
      fireEvent.click(screen.getByTestId('approver-stepup-sso-start'));
      expect(onStartSsoReauth).toHaveBeenCalledTimes(1);
      expect(registerApproverDeviceMock).not.toHaveBeenCalled();
    });

    it('disables the start button while the trip is starting', async () => {
      render(
        <ApproverDevicesSection passkeyCount={0} mfaMethod={null} hasPassword={false} isStartingSsoReauth onStartSsoReauth={vi.fn()} />,
      );
      expect(await screen.findByTestId('approver-stepup-sso-start')).toBeDisabled();
    });

    it('renders the verify step ABOVE the device-name field (the label does not survive the IdP trip)', async () => {
      render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} hasPassword={false} onStartSsoReauth={vi.fn()} />);
      const start = await screen.findByTestId('approver-stepup-sso-start');
      const labelInput = screen.getByTestId('approver-device-label-input');
      expect(start.compareDocumentPosition(labelInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('with a grant in hand: registers with the grant and reports it spent BEFORE the ceremony settles', async () => {
      let resolveRegister: () => void = () => {};
      registerApproverDeviceMock.mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveRegister = resolve; }),
      );
      const onSsoReauthGrantSpent = vi.fn();
      render(
        <ApproverDevicesSection
          passkeyCount={0}
          mfaMethod={null}
          hasPassword={false}
          ssoReauthGrantId="sso-g"
          onStartSsoReauth={vi.fn()}
          onSsoReauthGrantSpent={onSsoReauthGrantSpent}
        />,
      );
      await screen.findByTestId('approver-device-dev-1');

      expect(screen.getByTestId('approver-stepup-sso-verified')).toBeTruthy();
      expect(screen.queryByTestId('approver-stepup-sso-start')).toBeNull();
      const register = screen.getByTestId('approver-device-register');
      expect(register).not.toBeDisabled();
      fireEvent.change(screen.getByTestId('approver-device-label-input'), { target: { value: 'Desk' } });
      fireEvent.click(register);

      await waitFor(() =>
        expect(registerApproverDeviceMock).toHaveBeenCalledWith('Desk', { method: 'sso', ssoReauthGrantId: 'sso-g' }),
      );
      // Still pending: the grant is already reported spent.
      expect(onSsoReauthGrantSpent).toHaveBeenCalledTimes(1);
      expect(onSsoReauthGrantSpent.mock.invocationCallOrder[0]).toBeLessThan(
        registerApproverDeviceMock.mock.invocationCallOrder[0],
      );
      resolveRegister();
      await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
    });

    it('a stronger factor outranks the IdP: passkey tier, no SSO button', async () => {
      render(<ApproverDevicesSection passkeyCount={1} mfaMethod="passkey" hasPassword={false} onStartSsoReauth={vi.fn()} />);
      await screen.findByTestId('approver-device-dev-1');
      expect(screen.getByTestId('approver-stepup-passkey-note')).toBeTruthy();
      expect(screen.queryByTestId('approver-stepup-sso-start')).toBeNull();
    });

    it('an authenticator app held as a backup outranks the IdP too', async () => {
      render(
        <ApproverDevicesSection passkeyCount={0} mfaMethod="passkey" totpEnrolled hasPassword={false} onStartSsoReauth={vi.fn()} />,
      );
      await screen.findByTestId('approver-device-dev-1');
      expect(screen.getByTestId('approver-stepup-code')).toBeTruthy();
      expect(screen.queryByTestId('approver-stepup-sso-start')).toBeNull();
    });

    it.each([
      ['enrollment_grant_expired', { status: 400, code: 'enrollment_grant_expired' }, 'Your identity verification has expired. Please verify with your identity provider again.'],
      ['enrollment_proof_required', { status: 400 }, 'enrollment_proof_required'],
    ])('maps %s to "verify again" (not "session expired", not the raw server text)', async (_name, shape, message) => {
      registerApproverDeviceMock.mockRejectedValueOnce(Object.assign(new Error(message), shape));
      render(
        <ApproverDevicesSection passkeyCount={0} mfaMethod={null} hasPassword={false} ssoReauthGrantId="sso-g" onStartSsoReauth={vi.fn()} />,
      );
      await screen.findByTestId('approver-device-dev-1');
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: SSO_EXPIRED }));
      expect(showToastMock).toHaveBeenCalledTimes(1);
    });

    // The account gained a password after the page loaded: the server refuses
    // the SSO road with the opaque invalid_credentials. "Incorrect password"
    // would be nonsense on a form with no password field, and "verify again"
    // would loop (the IdP start refuses an account with a password).
    it('maps invalid_credentials on the sso tier to "reload", not "Incorrect password"', async () => {
      registerApproverDeviceMock.mockRejectedValueOnce(
        Object.assign(new Error('Invalid credentials'), { status: 400, code: 'invalid_credentials' }),
      );
      render(
        <ApproverDevicesSection passkeyCount={0} mfaMethod={null} hasPassword={false} ssoReauthGrantId="sso-g" onStartSsoReauth={vi.fn()} />,
      );
      await screen.findByTestId('approver-device-dev-1');
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Your sign-in options changed. Reload the page and try again.',
        }),
      );
      expect(showToastMock).not.toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' });
    });

    it('lands on the register button when returning from the IdP', async () => {
      render(
        <ApproverDevicesSection
          passkeyCount={0}
          mfaMethod={null}
          hasPassword={false}
          ssoReauthGrantId="sso-g"
          onStartSsoReauth={vi.fn()}
          landOnRegister
        />,
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('approver-device-register')));
    });
  });

  it('revokes a device after confirming in the dialog', async () => {
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.click(screen.getByTestId('approver-device-revoke-dev-1'));
    // A confirm dialog appears before any network call.
    const confirmBtn = await screen.findByTestId('approver-device-revoke-confirm');
    expect(revokeApproverDeviceMock).not.toHaveBeenCalled();

    fireEvent.click(confirmBtn);

    await waitFor(() => expect(revokeApproverDeviceMock).toHaveBeenCalledWith('dev-1'));
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });
});
