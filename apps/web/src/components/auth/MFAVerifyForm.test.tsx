import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MFAVerifyForm from './MFAVerifyForm';

describe('MFAVerifyForm recovery codes', () => {
  it('renders only allowed alternatives and normalizes an eight-character recovery code', async () => {
    const onSubmit = vi.fn();
    render(
      <MFAVerifyForm
        mfaMethod="totp"
        allowedMethods={['totp', 'recovery_code']}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByTestId('mfa-passkey-alternate')).toBeNull();
    fireEvent.click(screen.getByTestId('mfa-method-recovery_code'));
    const input = screen.getByTestId('mfa-recovery-code');
    fireEvent.change(input, { target: { value: 'ab12cd34' } });
    expect(input).toHaveValue('AB12-CD34');
    fireEvent.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('AB12-CD34', 'recovery_code'));
  });

  it('clears a recovery code when switching back to another factor', () => {
    render(
      <MFAVerifyForm
        mfaMethod="totp"
        allowedMethods={['totp', 'recovery_code']}
      />,
    );
    fireEvent.click(screen.getByTestId('mfa-method-recovery_code'));
    fireEvent.change(screen.getByTestId('mfa-recovery-code'), { target: { value: 'AB12-CD34' } });
    fireEvent.click(screen.getByTestId('mfa-method-totp'));
    fireEvent.click(screen.getByTestId('mfa-method-recovery_code'));
    expect(screen.getByTestId('mfa-recovery-code')).toHaveValue('');
  });
});
