import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiVerifyPasskeyMFAMock } = vi.hoisted(() => ({
  apiVerifyPasskeyMFAMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn> }) => unknown) =>
      selector({ login: vi.fn() }),
    {},
  ),
  apiLogin: vi.fn(),
  apiVerifyMFA: vi.fn(),
  apiVerifyPasskeyMFA: apiVerifyPasskeyMFAMock,
  apiSendSmsMfaCode: vi.fn(),
  fetchAndApplyPreferences: vi.fn(),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ cfAccessLogin: { enabled: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

import LoginPage from './LoginPage';
import { apiLogin } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

const baseLoginSuccess = {
  success: true,
  user: { id: 'u1', email: 'jane@example.com', name: 'Jane', mfaEnabled: true },
  tokens: { accessToken: 'a', expiresInSeconds: 900 },
  requiresSetup: false,
};

async function fillAndSubmit(email = 'jane@example.com', password = 'Sup3rSecure!') {
  await waitFor(() => screen.getByLabelText(/email/i));
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage passkey MFA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a passkey assertion instead of the six-digit MFA form when login returns mfaMethod passkey', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      tempToken: 'temp-passkey',
      mfaMethod: 'passkey',
    } as any);
    apiVerifyPasskeyMFAMock.mockResolvedValueOnce(baseLoginSuccess);

    render(<LoginPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    expect(await screen.findByText(/Use your passkey/i)).toBeTruthy();
    expect(screen.queryByTestId('mfa-digit-0')).toBeNull();

    fireEvent.click(screen.getByTestId('mfa-passkey-submit'));

    await waitFor(() => expect(apiVerifyPasskeyMFAMock).toHaveBeenCalled());
    expect(apiVerifyPasskeyMFAMock).toHaveBeenCalledWith('temp-passkey');
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc');
  });
});
