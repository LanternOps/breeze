import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiLogin } from '../../stores/auth';
import MFAVerifyForm from './MFAVerifyForm';

afterEach(() => vi.unstubAllGlobals());

async function loginWith(payload: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    mfaRequired: true, tempToken: 'temp', ...payload,
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
  return apiLogin('user@example.com', 'password');
}

describe('apiLogin to MFAVerifyForm strict method contract', () => {
  it.each([
    { label: 'empty', allowedMethods: [] },
    { label: 'unsupported', allowedMethods: ['unsupported'] },
    { label: 'malformed', allowedMethods: { totp: true } },
  ])('fails closed for an explicit $label method field', async ({ allowedMethods }) => {
    const result = await loginWith({ mfaMethod: 'totp', allowedMethods });
    render(<MFAVerifyForm mfaMethod={result.mfaMethod} allowedMethods={result.allowedMethods} />);

    expect(result.allowedMethods).toEqual([]);
    expect(screen.getByTestId('mfa-no-supported-methods')).toBeTruthy();
    expect(screen.queryByTestId('mfa-submit')).toBeNull();
  });

  it('uses the explicit method instead of a mismatched primary', async () => {
    const onSubmit = vi.fn();
    const result = await loginWith({ mfaMethod: 'totp', allowedMethods: ['sms'] });
    render(<MFAVerifyForm mfaMethod={result.mfaMethod} allowedMethods={result.allowedMethods} onSubmit={onSubmit} smsSent />);
    screen.getAllByRole('textbox').forEach((input, index) => {
      fireEvent.change(input, { target: { value: String(index + 1) } });
    });
    fireEvent.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('123456', 'sms'));
  });

  it('renders only passkey for an explicit passkey-only response', async () => {
    const result = await loginWith({ mfaMethod: 'totp', allowedMethods: ['passkey'] });
    render(<MFAVerifyForm mfaMethod={result.mfaMethod} allowedMethods={result.allowedMethods} onPasskeyVerify={vi.fn()} />);

    expect(screen.getByTestId('mfa-passkey-submit')).toBeTruthy();
    expect(screen.queryByTestId('mfa-digit-0')).toBeNull();
    expect(screen.queryByTestId('mfa-method-totp')).toBeNull();
  });
});
