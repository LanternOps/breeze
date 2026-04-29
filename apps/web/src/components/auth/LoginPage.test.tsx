import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn> }) => unknown) =>
      selector({ login: vi.fn() }),
    {},
  ),
  apiLogin: vi.fn(),
  apiVerifyMFA: vi.fn(),
  apiSendSmsMfaCode: vi.fn(),
  fetchAndApplyPreferences: vi.fn(),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import LoginPage from './LoginPage';
import { apiLogin, apiVerifyMFA } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

const baseLoginSuccess = {
  success: true,
  user: { id: 'u1', email: 'jane@example.com', name: 'Jane', mfaEnabled: false },
  tokens: { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 900 },
  requiresSetup: false,
};

async function fillAndSubmit(email = 'jane@example.com', password = 'Sup3rSecure!') {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage navigation after login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to next when login succeeds and setup is complete', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce(baseLoginSuccess);
    render(<LoginPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc');
  });

  it('navigates to "/" when next is omitted', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce(baseLoginSuccess);
    render(<LoginPage />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });

  it('routes to /setup when requiresSetup is true, ignoring next', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce({ ...baseLoginSuccess, requiresSetup: true });
    render(<LoginPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/setup');
  });

  it('rewrites unsafe next to "/" before navigating', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce(baseLoginSuccess);
    render(<LoginPage next="https://evil.example.com" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });
});

describe('LoginPage navigation after MFA verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function loginToMfaState() {
    vi.mocked(apiLogin).mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      tempToken: 'temp-1',
      mfaMethod: 'totp',
    });
    await fillAndSubmit();
    await screen.findByText(/Verify your identity/i);
  }

  async function submitMfaCode() {
    for (let i = 0; i < 6; i++) {
      const input = screen.getByTestId(`mfa-digit-${i}`) as HTMLInputElement;
      fireEvent.change(input, { target: { value: String((i + 1) % 10) } });
    }
    fireEvent.click(screen.getByTestId('mfa-submit'));
  }

  it('honors next on MFA-verify success when setup is complete', async () => {
    render(<LoginPage next="/oauth/consent?uid=abc" />);
    await loginToMfaState();

    vi.mocked(apiVerifyMFA).mockResolvedValueOnce(baseLoginSuccess);
    await submitMfaCode();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc');
  });

  it('routes MFA verify to /setup when requiresSetup is true', async () => {
    render(<LoginPage next="/oauth/consent?uid=abc" />);
    await loginToMfaState();

    vi.mocked(apiVerifyMFA).mockResolvedValueOnce({ ...baseLoginSuccess, requiresSetup: true });
    await submitMfaCode();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/setup');
  });

  it('rewrites unsafe next to "/" before navigating after MFA verify', async () => {
    render(<LoginPage next="https://evil.example.com" />);
    await loginToMfaState();

    vi.mocked(apiVerifyMFA).mockResolvedValueOnce(baseLoginSuccess);
    await submitMfaCode();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });
});
