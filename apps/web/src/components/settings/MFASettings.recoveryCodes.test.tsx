import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MFASettings from './MFASettings';

/**
 * #4414 — `POST /auth/mfa/recovery-codes` REGENERATES: it hands back ten brand
 * new codes and invalidates every code the user already saved. The panel used
 * to offer it behind a "View codes" button, i.e. the plainest possible read
 * affordance wired to a destructive write, with the invalidation warning shown
 * only after the fact.
 *
 * The contract these tests pin:
 *   1. no read-shaped control anywhere — the only action is "Regenerate";
 *   2. the invalidation is stated BEFORE the request, in a confirm the user
 *      has to accept;
 *   3. nothing is POSTed until that confirm is accepted;
 *   4. a failed regeneration never presents stale codes as if they were new.
 */

const baseProps = {
  enabled: true,
  mfaMethod: 'totp',
} as const;

async function openRecoveryPanel() {
  const start = await screen.findByTestId('mfa-recovery-regenerate-start');
  fireEvent.click(start);
  await screen.findByTestId('mfa-recovery-regenerate');
}

function fillPassword(value = 'hunter2-pw') {
  const input = document.getElementById('mfa-recovery-password') as HTMLInputElement;
  expect(input).not.toBeNull();
  fireEvent.change(input, { target: { value } });
}

describe('MFASettings — recovery codes are regenerate-only (#4414)', () => {
  it('offers no read-shaped affordance: the status card action says Regenerate', async () => {
    render(<MFASettings {...baseProps} onGenerateRecoveryCodes={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /^View codes$/i })).toBeNull();
    const action = await screen.findByTestId('mfa-recovery-regenerate-start');
    expect(action.textContent).toMatch(/regenerate/i);
  });

  it('does not POST until the confirm dialog is accepted, and states the invalidation first', async () => {
    const onGenerateRecoveryCodes = vi.fn().mockResolvedValue(true);
    render(<MFASettings {...baseProps} onGenerateRecoveryCodes={onGenerateRecoveryCodes} />);

    await openRecoveryPanel();
    fillPassword();

    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));

    // The dialog is up and the mutation has NOT fired.
    const confirm = await screen.findByTestId('confirm-regenerate-recovery-codes');
    expect(onGenerateRecoveryCodes).not.toHaveBeenCalled();
    // The user is told what they are about to destroy, before they destroy it.
    expect(
      screen.getByText(/immediately invalidates every recovery code you have saved/i)
    ).toBeTruthy();

    fireEvent.click(confirm);
    await waitFor(() => expect(onGenerateRecoveryCodes).toHaveBeenCalledWith('hunter2-pw'));
  });

  it('dismissing the confirm leaves the existing codes untouched', async () => {
    const onGenerateRecoveryCodes = vi.fn().mockResolvedValue(true);
    render(<MFASettings {...baseProps} onGenerateRecoveryCodes={onGenerateRecoveryCodes} />);

    await openRecoveryPanel();
    fillPassword();
    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
    await screen.findByTestId('confirm-regenerate-recovery-codes');

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByTestId('confirm-regenerate-recovery-codes')).toBeNull()
    );
    expect(onGenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  it('never presents previously fetched codes as new when the regeneration fails', async () => {
    const onGenerateRecoveryCodes = vi.fn().mockResolvedValue(false);
    render(
      <MFASettings
        {...baseProps}
        recoveryCodes={['STALE-0001', 'STALE-0002']}
        errorMessage="Current password is incorrect"
        onGenerateRecoveryCodes={onGenerateRecoveryCodes}
      />
    );

    await openRecoveryPanel();
    fillPassword('wrong-pw');
    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
    fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

    await waitFor(() => expect(onGenerateRecoveryCodes).toHaveBeenCalled());
    expect(screen.getByText(/Current password is incorrect/i)).toBeTruthy();
    expect(screen.queryByText('STALE-0001')).toBeNull();
  });

  // The SMS enrollment road lands on this same view but renders from
  // `smsRecoveryCodes`, and `displayCodes` prefers it (`smsRecoveryCodes ||
  // recoveryCodes`). A regeneration only ever refreshes the `recoveryCodes`
  // PROP, so without clearing the SMS set the panel keeps showing codes the
  // regeneration just invalidated — the exact promise #4414 exists to make.
  it('replaces SMS-enrollment codes with the regenerated set', async () => {
    const onGenerateRecoveryCodes = vi.fn().mockResolvedValue(true);
    render(
      <MFASettings
        enabled={false}
        smsAllowed
        phoneVerified
        phoneLast4="1234"
        recoveryCodes={['REGENERATED-0001']}
        onEnableSmsMfa={vi.fn().mockResolvedValue({ success: true, recoveryCodes: ['SMS-0001'] })}
        onGenerateRecoveryCodes={onGenerateRecoveryCodes}
      />
    );

    // Two rows offer "Enable" while MFA is off; the SMS one is the second.
    const enableButtons = await screen.findAllByRole('button', { name: /^Enable$/i });
    fireEvent.click(enableButtons[enableButtons.length - 1]);
    const smsPassword = document.getElementById('mfa-sms-password') as HTMLInputElement;
    expect(smsPassword).not.toBeNull();
    fireEvent.change(smsPassword, { target: { value: 'hunter2-pw' } });
    fireEvent.click(screen.getByRole('button', { name: /Enable SMS MFA/i }));

    expect(await screen.findByText('SMS-0001')).toBeTruthy();

    fillPassword();
    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
    fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

    expect(await screen.findByText('REGENERATED-0001')).toBeTruthy();
    expect(screen.queryByText('SMS-0001')).toBeNull();
  });

  it('keeps the disable panel open when the code is rejected', async () => {
    const onDisable = vi.fn().mockResolvedValue(false);
    render(
      <MFASettings
        enabled
        mfaMethod="totp"
        errorMessage="Invalid MFA code"
        onDisable={onDisable}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Disable$/i }));
    await screen.findByRole('heading', { name: /Disable MFA/i });

    const digits = document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]');
    digits.forEach((input, index) => {
      fireEvent.change(input, { target: { value: String(index + 1) } });
    });
    const password = document.getElementById('mfa-disable-password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'hunter2-pw' } });

    fireEvent.click(screen.getByRole('button', { name: /^Disable MFA$/i }));

    await waitFor(() => expect(onDisable).toHaveBeenCalledWith('123456', 'hunter2-pw'));
    // A rejected disable used to collapse to a status card that still read
    // "Enabled" — the user could not tell that anything had failed.
    expect(await screen.findByText(/Invalid MFA code/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Disable MFA/i })).toBeTruthy();
    expect(screen.queryByTestId('mfa-recovery-regenerate-start')).toBeNull();
  });

  it('shows the new codes once the regeneration succeeds', async () => {
    const onGenerateRecoveryCodes = vi.fn().mockResolvedValue(true);
    render(
      <MFASettings
        {...baseProps}
        recoveryCodes={['FRESH-0001', 'FRESH-0002']}
        onGenerateRecoveryCodes={onGenerateRecoveryCodes}
      />
    );

    await openRecoveryPanel();
    fillPassword();
    fireEvent.click(screen.getByTestId('mfa-recovery-regenerate'));
    fireEvent.click(await screen.findByTestId('confirm-regenerate-recovery-codes'));

    expect(await screen.findByText('FRESH-0001')).toBeTruthy();
  });
});
