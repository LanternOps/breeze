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
  // LoginForm's useRegistrationGate loads /config via fetchWithAuth.
  fetchWithAuth: vi.fn(async () => new Response('{}', { status: 200 })),
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

  // #2153: when the primary method is TOTP but the account also has a passkey,
  // the code form still renders AND an "or use a passkey" affordance appears.
  it('offers a passkey alternate alongside the code form when login returns passkeyAvailable', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      tempToken: 'temp-totp',
      mfaMethod: 'totp',
      passkeyAvailable: true,
    } as any);
    apiVerifyPasskeyMFAMock.mockResolvedValueOnce(baseLoginSuccess);

    render(<LoginPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    // The authenticator-code form is still the primary prompt...
    expect(await screen.findByTestId('mfa-digit-0')).toBeTruthy();
    // ...and the passkey alternate is offered.
    const alternate = await screen.findByTestId('mfa-passkey-alternate');
    fireEvent.click(alternate);

    await waitFor(() => expect(apiVerifyPasskeyMFAMock).toHaveBeenCalled());
    expect(apiVerifyPasskeyMFAMock).toHaveBeenCalledWith('temp-totp');
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc');
  });

  // Guard: no passkey alternate when the account has none.
  it('does not offer a passkey alternate when passkeyAvailable is false', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      tempToken: 'temp-totp',
      mfaMethod: 'totp',
      passkeyAvailable: false,
    } as any);

    render(<LoginPage next="/" />);

    await fillAndSubmit();

    expect(await screen.findByTestId('mfa-digit-0')).toBeTruthy();
    expect(screen.queryByTestId('mfa-passkey-alternate')).toBeNull();
  });
});
