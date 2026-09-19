import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MFAVerifyForm from './MFAVerifyForm';

describe('MFAVerifyForm', () => {
  it('hides the selector for one method and shows every authorized choice for multiple methods', () => {
    const { rerender } = render(<MFAVerifyForm mfaMethod="totp" methods={['totp']} />);
    expect(screen.queryByTestId('mfa-method-select')).toBeNull();

    rerender(<MFAVerifyForm mfaMethod="totp" methods={['totp', 'sms', 'passkey', 'recovery']} />);
    const options = Array.from((screen.getByTestId('mfa-method-select') as HTMLSelectElement).options);
    expect(options.map((option) => option.value)).toEqual(['totp', 'sms', 'passkey', 'recovery']);
  });

  it('preserves recovery-code separators and trims only outer whitespace', async () => {
    const onSubmit = vi.fn();
    render(<MFAVerifyForm mfaMethod="recovery" methods={['recovery']} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('mfa-recovery-code'), { target: { value: '  abcd - 1234  ' } });
    fireEvent.click(screen.getByTestId('mfa-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('abcd - 1234'));
  });

  it('notifies the parent when selecting an alternate method', () => {
    const onMethodChange = vi.fn();
    render(
      <MFAVerifyForm
        mfaMethod="totp"
        methods={['totp', 'recovery']}
        onMethodChange={onMethodChange}
      />,
    );
    fireEvent.change(screen.getByTestId('mfa-method-select'), { target: { value: 'recovery' } });
    expect(onMethodChange).toHaveBeenCalledWith('recovery');
  });

  it('automatically sends SMS once when SMS becomes selected', async () => {
    const onSendSmsCode = vi.fn(async () => true);
    const { rerender } = render(
      <MFAVerifyForm mfaMethod="totp" methods={['totp', 'sms']} onSendSmsCode={onSendSmsCode} />,
    );
    rerender(<MFAVerifyForm mfaMethod="sms" methods={['totp', 'sms']} onSendSmsCode={onSendSmsCode} />);
    await waitFor(() => expect(onSendSmsCode).toHaveBeenCalledOnce());
    rerender(<MFAVerifyForm mfaMethod="sms" methods={['totp', 'sms']} onSendSmsCode={onSendSmsCode} />);
    expect(onSendSmsCode).toHaveBeenCalledOnce();
  });
});
