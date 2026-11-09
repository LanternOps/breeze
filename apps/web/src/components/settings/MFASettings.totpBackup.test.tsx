import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MFASettings from './MFASettings';

/**
 * #10650 (W02 of #11420): an authenticator app as a BACKUP beside a primary
 * passkey. `mfaMethod` names the primary only, so the Authenticator row now
 * reads `totpEnrolled` (from `GET /users/me`) and the passkey count to tell
 * the five account states apart, and gains an add-backup and a remove flow.
 */

function fillDigits(code = '123456') {
  const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"][maxlength="1"]');
  expect(digits.length).toBe(6);
  code.split('').forEach((digit, index) => {
    fireEvent.change(digits[index], { target: { value: digit } });
  });
}

const row = () => screen.getByTestId('mfa-authenticator-row');

describe('MFASettings — Authenticator row states', () => {
  it('passkey primary without TOTP, policy allows it: "Not set up" with Add backup', () => {
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled={false} totpAllowed passkeyCount={1} />);

    expect(screen.getByTestId('mfa-authenticator-status').textContent).toBe('Not set up');
    expect(row().textContent).toContain(
      "Add an authenticator app as a backup, so you can still sign in if your passkey isn't available.",
    );
    expect(screen.getByTestId('mfa-totp-backup-start')).toBeTruthy();
    expect(screen.queryByTestId('mfa-setup-start')).toBeNull();
  });

  it('opens the existing password gate from Add backup', () => {
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled={false} totpAllowed passkeyCount={1} />);

    fireEvent.click(screen.getByTestId('mfa-totp-backup-start'));

    expect(screen.getByTestId('mfa-current-password')).toBeTruthy();
  });

  it('still offers Add backup when the policy is unknown (the server answers)', () => {
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled={false} passkeyCount={1} />);

    expect(screen.getByTestId('mfa-totp-backup-start')).toBeTruthy();
  });

  it('passkey primary without TOTP, policy disallows it: "Not available" and no action', () => {
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled={false} totpAllowed={false} passkeyCount={1} />);

    expect(screen.getByTestId('mfa-authenticator-status').textContent).toBe('Not available');
    expect(row().textContent).toContain("Your organization's policy doesn't allow authenticator apps.");
    expect(row().querySelector('button')).toBeNull();
  });

  it('passkey primary with a TOTP backup: "Backup" with Remove', () => {
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled passkeyCount={1} />);

    expect(screen.getByTestId('mfa-authenticator-status').textContent).toBe('Backup');
    expect(row().textContent).toContain(
      "Use a code from your authenticator app if your passkey isn't available.",
    );
    expect(screen.getByTestId('mfa-totp-backup-remove-start')).toBeTruthy();
    expect(screen.queryByTestId('mfa-totp-backup-start')).toBeNull();
  });

  it('TOTP primary without passkeys: unchanged — "Enabled" with Disable', () => {
    render(<MFASettings enabled mfaMethod="totp" totpEnrolled passkeyCount={0} />);

    expect(screen.getByTestId('mfa-authenticator-status').textContent).toBe('Enabled');
    expect(row().textContent).toContain('Your account is protected with an authenticator app.');
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(screen.queryByTestId('mfa-totp-remove-start')).toBeNull();
  });

  it('TOTP primary with passkeys: Remove (which promotes a passkey) instead of Disable', async () => {
    const onRemoveTotp = vi.fn(async () => true);
    const onDisable = vi.fn();
    render(
      <MFASettings
        enabled
        mfaMethod="totp"
        totpEnrolled
        passkeyCount={2}
        onRemoveTotp={onRemoveTotp}
        onDisable={onDisable}
      />,
    );

    expect(screen.getByTestId('mfa-authenticator-status').textContent).toBe('Enabled');
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    fireEvent.click(screen.getByTestId('mfa-totp-remove-start'));

    expect(screen.getByText('Your passkey becomes your primary sign-in method. Your recovery codes stay the same.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    await waitFor(() => expect(onRemoveTotp).toHaveBeenCalledWith('pw', { method: 'passkey' }));
    expect(onDisable).not.toHaveBeenCalled();
    // Success returns to the status card.
    await screen.findByTestId('mfa-authenticator-row');
  });

  it('an account with no MFA keeps the original Enable button', () => {
    render(<MFASettings enabled={false} mfaMethod={null} />);

    expect(screen.getByTestId('mfa-authenticator-status').textContent).toBe('Disabled');
    expect(screen.getByTestId('mfa-setup-start')).toBeTruthy();
  });
});

describe('MFASettings — adding the backup', () => {
  const backupSetupProps = {
    enabled: true,
    mfaMethod: 'passkey' as const,
    totpEnrolled: false,
    totpAllowed: true,
    passkeyCount: 1,
    qrCodeDataUrl: 'data:image/png;base64,abc',
    totpSecret: 'JBSWY3DPEHPK3PXP',
  };

  async function reachQr(onEnable: Parameters<typeof MFASettings>[0]['onEnable']) {
    const onRequestSetup = vi.fn(async () => true);
    render(<MFASettings {...backupSetupProps} onRequestSetup={onRequestSetup} onEnable={onEnable} />);
    fireEvent.click(screen.getByTestId('mfa-totp-backup-start'));
    fireEvent.change(screen.getByTestId('mfa-current-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(/Set up authenticator/i);
    expect(onRequestSetup).toHaveBeenCalledWith('pw');
  }

  it('says the passkey will be asked for, and never opens the recovery-code dialog', async () => {
    const onEnable = vi.fn(async () => 'backup-added' as const);
    await reachQr(onEnable);

    expect(screen.getByTestId('mfa-totp-backup-passkey-note').textContent).toBe(
      "When you press Verify, you'll confirm with your passkey.",
    );
    fillDigits();
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await waitFor(() => expect(onEnable).toHaveBeenCalledWith('123456', 'pw'));
    await screen.findByTestId('mfa-authenticator-row');
    expect(screen.queryByRole('dialog', { name: 'Save your recovery codes' })).toBeNull();
    expect(screen.queryByTestId('mfa-recovery-done')).toBeNull();
  });

  it('keeps the code on screen when the passkey prompt was cancelled (nothing was sent)', async () => {
    const onEnable = vi.fn(async () => 'not-sent' as const);
    await reachQr(onEnable);

    fillDigits('654321');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and add backup' }));

    await waitFor(() => expect(onEnable).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Set up authenticator/i)).toBeTruthy();
    const digits = Array.from(document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"][maxlength="1"]'));
    expect(digits.map((d) => d.value).join('')).toBe('654321');
    // The "code not accepted" hint is for a REJECTED code, not a cancelled prompt.
    expect(screen.queryByTestId('mfa-code-rejected-hint')).toBeNull();
  });
});

describe('MFASettings — removing the authenticator app', () => {
  it('defaults the proof to the passkey and switches to a 6-digit code', async () => {
    const onRemoveTotp = vi.fn(async () => true);
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled passkeyCount={1} onRemoveTotp={onRemoveTotp} />);

    fireEvent.click(screen.getByTestId('mfa-totp-backup-remove-start'));
    expect(screen.getByText("You'll keep signing in with your passkey. Your recovery codes stay the same.")).toBeTruthy();
    expect(screen.getByTestId('mfa-totp-remove-passkey-note')).toBeTruthy();
    expect(screen.queryByTestId('mfa-totp-remove-code')).toBeNull();

    fireEvent.click(screen.getByTestId('mfa-totp-remove-use-code'));
    expect(screen.queryByTestId('mfa-totp-remove-passkey-note')).toBeNull();
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    const submit = screen.getByTestId('mfa-totp-remove-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('mfa-totp-remove-code'), { target: { value: '12a3456' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onRemoveTotp).toHaveBeenCalledWith('pw', { method: 'totp', code: '123456' }));
  });

  it('stays on the remove view when the removal is rejected', async () => {
    const onRemoveTotp = vi.fn(async () => false);
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled passkeyCount={1} onRemoveTotp={onRemoveTotp} errorMessage="Nope" />);

    fireEvent.click(screen.getByTestId('mfa-totp-backup-remove-start'));
    fireEvent.change(screen.getByTestId('mfa-totp-remove-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('mfa-totp-remove-submit'));

    await waitFor(() => expect(onRemoveTotp).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('mfa-totp-remove-submit')).toBeTruthy();
    expect(screen.getByText('Nope')).toBeTruthy();
  });

  it('a passwordless account without a grant verifies with its identity provider', () => {
    const onSsoReauthManage = vi.fn();
    const onRemoveTotp = vi.fn();
    render(
      <MFASettings
        enabled
        mfaMethod="passkey"
        totpEnrolled
        passkeyCount={1}
        hasPassword={false}
        ssoReauthGrantAvailable={false}
        onSsoReauthManage={onSsoReauthManage}
        onRemoveTotp={onRemoveTotp}
      />,
    );

    fireEvent.click(screen.getByTestId('mfa-totp-backup-remove-start'));
    expect(screen.queryByTestId('mfa-totp-remove-password')).toBeNull();
    expect(screen.queryByTestId('mfa-totp-remove-submit')).toBeNull();
    fireEvent.click(screen.getByTestId('mfa-totp-remove-sso-reauth'));

    expect(onSsoReauthManage).toHaveBeenCalledWith('remove_totp');
    expect(onRemoveTotp).not.toHaveBeenCalled();
  });

  it('reopens the remove view when the IdP round-trip returns to it', () => {
    render(
      <MFASettings
        enabled
        mfaMethod="passkey"
        totpEnrolled
        passkeyCount={1}
        hasPassword={false}
        ssoReauthGrantAvailable
        ssoResumeView="remove-totp"
      />,
    );

    expect(screen.getByTestId('mfa-totp-remove-submit')).toBeTruthy();
    expect(screen.getByTestId('mfa-sso-manage-proof')).toBeTruthy();
  });
});

describe('MFASettings — recovery-code rotation with the backup', () => {
  it('offers the authenticator app instead of the passkey', async () => {
    const onGenerateRecoveryCodes = vi.fn(async () => true);
    render(
      <MFASettings
        enabled
        mfaMethod="passkey"
        totpEnrolled
        passkeyCount={1}
        recoveryCodes={['AAAA-1111']}
        onGenerateRecoveryCodes={onGenerateRecoveryCodes}
      />,
    );

    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate-start'));
    expect(screen.queryByTestId('mfa-recovery-factor-code')).toBeNull();
    fireEvent.click(screen.getByTestId('mfa-recovery-use-totp'));
    fireEvent.change(screen.getByLabelText('Current password', { selector: '#mfa-recovery-password' }), { target: { value: 'pw' } });
    const regenerate = screen.getByTestId('mfa-recovery-regenerate') as HTMLButtonElement;
    expect(regenerate.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('mfa-recovery-factor-code'), { target: { value: '123456' } });
    expect(regenerate.disabled).toBe(false);
    fireEvent.click(regenerate);
    fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

    await waitFor(() => expect(onGenerateRecoveryCodes).toHaveBeenCalledWith('pw', '123456', 'totp'));
  });

  it('a passkey-only account is not offered the authenticator app', () => {
    render(<MFASettings enabled mfaMethod="passkey" totpEnrolled={false} passkeyCount={1} />);

    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate-start'));
    expect(screen.queryByTestId('mfa-recovery-use-totp')).toBeNull();
  });
});
