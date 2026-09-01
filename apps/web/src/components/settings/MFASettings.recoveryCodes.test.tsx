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
