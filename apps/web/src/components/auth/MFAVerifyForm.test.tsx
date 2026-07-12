import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MFAVerifyForm from './MFAVerifyForm';

describe('MFAVerifyForm recovery codes', () => {
  it('uses the first explicit allowed method when the primary method is not allowed', async () => {
    const onSubmit = vi.fn();
    render(<MFAVerifyForm mfaMethod="totp" allowedMethods={['sms']} onSubmit={onSubmit} smsSent />);

    expect(screen.queryByTestId('mfa-method-totp')).toBeNull();
    const inputs = screen.getAllByRole('textbox');
    inputs.forEach((input, index) => fireEvent.change(input, { target: { value: String(index + 1) } }));
    fireEvent.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('123456', 'sms'));
  });

  it.each([
    { allowedMethods: [] },
    { allowedMethods: ['unsupported' as never] },
  ])('fails closed for an explicit unsupported method list %#', ({ allowedMethods }) => {
    const onSubmit = vi.fn();
    render(<MFAVerifyForm mfaMethod="totp" allowedMethods={allowedMethods} onSubmit={onSubmit} />);

    expect(screen.getByTestId('mfa-no-supported-methods')).toBeTruthy();
    expect(screen.queryByTestId('mfa-submit')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

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
