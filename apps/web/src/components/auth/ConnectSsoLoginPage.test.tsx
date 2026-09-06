import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const loginMock = vi.fn();

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn> }) => unknown) => selector({ login: loginMock }),
    {},
  ),
  apiSsoLinkPending: vi.fn(),
  apiSsoLinkConfirm: vi.fn(),
  apiVerifyMFA: vi.fn(),
  apiVerifyPasskeyMFA: vi.fn(),
  apiSendSmsMfaCode: vi.fn(),
  fetchAndApplyPreferences: vi.fn(),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import ConnectSsoLoginPage from './ConnectSsoLoginPage';
import { apiSsoLinkPending, apiSsoLinkConfirm, apiVerifyMFA } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

const PENDING = { success: true as const, email: 'v@example.com', providerName: 'Acme IdP' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiSsoLinkPending).mockResolvedValue(PENDING);
});

async function submitPassword(password = 'hunter2!') {
  await waitFor(() => screen.getByTestId('connect-sso-password'));
  fireEvent.change(screen.getByTestId('connect-sso-password'), { target: { value: password } });
  fireEvent.click(screen.getByTestId('connect-sso-submit'));
}

describe('ConnectSsoLoginPage (#4067)', () => {
  it('describes the ceremony (account email) and completes login on password confirm', async () => {
    vi.mocked(apiSsoLinkConfirm).mockResolvedValue({
      state: 'complete',
      user: { id: 'u1', email: 'v@example.com', name: 'V' } as never,
      tokens: { accessToken: 'a', expiresInSeconds: 900 } as never,
      requiresSetup: false,
      redirectPath: '/dashboard',
    });

    render(<ConnectSsoLoginPage />);
    await submitPassword();

    await waitFor(() => expect(apiSsoLinkConfirm).toHaveBeenCalledWith('hunter2!'));
    expect((screen.getByTestId('connect-sso-email') as HTMLInputElement).value).toBe('v@example.com');
    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/dashboard');
  });

  it('shows the expired state when the ceremony is gone (no cookie / TTL elapsed)', async () => {
    vi.mocked(apiSsoLinkPending).mockResolvedValue({ success: false, expired: true });

    render(<ConnectSsoLoginPage />);

    await waitFor(() => screen.getByTestId('connect-sso-expired'));
    expect(screen.getByTestId('connect-sso-back-to-login')).toHaveAttribute('href', '/login');
  });

  it('surfaces the generic error on a wrong password without navigating', async () => {
    vi.mocked(apiSsoLinkConfirm).mockResolvedValue({ state: 'failed', reason: 'other', error: 'Invalid email or password' });

    render(<ConnectSsoLoginPage />);
    await submitPassword('wrong');

    await waitFor(() => screen.getByTestId('connect-sso-error'));
    expect(navigateTo).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('hands off to the MFA step when confirm returns mfaRequired, then completes via mfa verify', async () => {
    vi.mocked(apiSsoLinkConfirm).mockResolvedValue({
      state: 'mfa',
      challenge: {
        tempToken: 'temp-1',
        primary: 'totp',
        methods: ['totp'],
        allowedMethods: { totp: true, sms: false, passkey: false },
        recoveryAvailable: false,
        phoneLast4: null,
      },
    });
    vi.mocked(apiVerifyMFA).mockResolvedValue({
      success: true,
      user: { id: 'u1', email: 'v@example.com', name: 'V' } as never,
      tokens: { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 900 } as never,
      requiresSetup: false,
      redirectPath: '/dashboard',
    });

    render(<ConnectSsoLoginPage />);
    await submitPassword();

    // MFA form appears; the identity was NOT linked yet.
    await waitFor(() => screen.getByText(/verify your identity/i));
    expect(loginMock).not.toHaveBeenCalled();

    for (let i = 0; i < 6; i++) {
      fireEvent.change(screen.getByTestId(`mfa-digit-${i}`), { target: { value: String(i + 1) } });
    }
    fireEvent.click(screen.getByTestId('mfa-submit'));

    await waitFor(() => expect(apiVerifyMFA).toHaveBeenCalledWith('123456', 'temp-1', 'totp'));
    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/dashboard');
  });

  it('renders the retryable unavailable state (NOT expired) on a transient describe failure, and recovers on retry', async () => {
    vi.mocked(apiSsoLinkPending)
      .mockResolvedValueOnce({ success: false, expired: false, error: 'Network error' })
      .mockResolvedValueOnce(PENDING);

    render(<ConnectSsoLoginPage />);

    // A 503/429/network blip must NOT read as "expired" — that would send the
    // user on a needless full IdP round-trip while the record is still valid.
    await waitFor(() => screen.getByTestId('connect-sso-unavailable'));
    expect(screen.queryByTestId('connect-sso-expired')).toBeNull();

    fireEvent.click(screen.getByTestId('connect-sso-retry'));
    await waitFor(() => screen.getByTestId('connect-sso-form'));
    expect(apiSsoLinkPending).toHaveBeenCalledTimes(2);
  });

  it('shows translated copy for a completion failure instead of stranding the user on the MFA form', async () => {
    vi.mocked(apiSsoLinkConfirm).mockResolvedValue({ state: 'failed', reason: 'completion_failed' });

    render(<ConnectSsoLoginPage />);
    await submitPassword();

    await waitFor(() => screen.getByTestId('connect-sso-error'));
    expect(screen.getByTestId('connect-sso-error').textContent).toMatch(/could not be completed/i);
  });

  it('flips to the expired state when confirm reports the ceremony expired', async () => {
    vi.mocked(apiSsoLinkConfirm).mockResolvedValue({ state: 'failed', reason: 'expired' });

    render(<ConnectSsoLoginPage />);
    await submitPassword();

    await waitFor(() => screen.getByTestId('connect-sso-expired'));
  });
});
