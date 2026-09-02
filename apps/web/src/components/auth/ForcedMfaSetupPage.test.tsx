import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const commitMfaEnrollmentIfCurrent = vi.fn();
const authState = {
  commitMfaEnrollmentIfCurrent,
  isAuthenticated: true,
  tokens: { accessToken: 'existing', expiresInSeconds: 900 },
  user: { id: 'user-1', email: 'user@example.com', name: 'User', mfaEnabled: false },
  sessionGeneration: 1,
};

vi.mock('../../stores/auth', () => ({
  AuthSessionExpiredError: class AuthSessionExpiredError extends Error {},
  AuthThrottledError: class AuthThrottledError extends Error {},
  apiEnableSmsMfa: vi.fn(),
  apiEnableTotpMfa: vi.fn(),
  apiEnrollPasskey: vi.fn(),
  apiGetMfaEnrollmentOptions: vi.fn(),
  fetchWithAuth: vi.fn(),
  restoreAccessTokenFromCookie: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

vi.mock('../../lib/navigation', () => ({ navigateTo: vi.fn() }));

vi.mock('./MFASetupForm', () => ({
  default: ({ onSubmit }: { onSubmit: (code: string) => void }) => (
    <button data-testid="confirm-totp" onClick={() => onSubmit('123456')}>Confirm TOTP</button>
  ),
}));

import ForcedMfaSetupPage from './ForcedMfaSetupPage';
import {
  apiEnableSmsMfa,
  apiEnableTotpMfa,
  apiEnrollPasskey,
  apiGetMfaEnrollmentOptions,
  fetchWithAuth,
} from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';

const replacement = {
  success: true as const,
  recoveryCodes: ['RC-ONE', 'RC-TWO'],
  tokens: { accessToken: 'replacement', expiresInSeconds: 900 },
};

function options(totp: boolean, sms: boolean, passkey: boolean, phoneConfigured = true) {
  return {
    success: true as const,
    options: { allowedMethods: { totp, sms, passkey }, phoneConfigured },
  };
}

async function enterPasswordAndContinue() {
  await waitFor(() => screen.getByLabelText(/current password/i));
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: 'correct horse' } });
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.sessionGeneration = 1;
  commitMfaEnrollmentIfCurrent.mockImplementation((generation: number) => generation === authState.sessionGeneration);
  vi.mocked(apiGetMfaEnrollmentOptions).mockResolvedValue(options(true, false, true));
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ qrCodeDataUrl: 'data:image/png;base64,qr' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
});

describe('ForcedMfaSetupPage policy-driven enrollment', () => {
  it('fails closed when options cannot load', async () => {
    vi.mocked(apiGetMfaEnrollmentOptions).mockResolvedValue({ success: false, error: 'Policy unavailable' });

    render(<ForcedMfaSetupPage />);

    expect(await screen.findByTestId('mfa-options-error')).toHaveTextContent(/contact your administrator/i);
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  });

  it('fails closed when policy has no usable enrollment method', async () => {
    vi.mocked(apiGetMfaEnrollmentOptions).mockResolvedValue(options(false, true, false, false));

    render(<ForcedMfaSetupPage />);

    expect(await screen.findByTestId('mfa-options-empty')).toHaveTextContent(/contact your administrator/i);
  });

  it('shows permitted choices but disables SMS until a phone is configured', async () => {
    vi.mocked(apiGetMfaEnrollmentOptions).mockResolvedValue(options(true, true, true, false));

    render(<ForcedMfaSetupPage />);

    expect(await screen.findByTestId('enroll-method-totp')).toBeEnabled();
    expect(screen.getByTestId('enroll-method-sms')).toBeDisabled();
    expect(screen.getByTestId('enroll-method-passkey')).toBeEnabled();
    expect(screen.getByText(/add and verify a phone number/i)).toBeInTheDocument();
  });

  it('does not expose recovery codes during TOTP setup or after failed confirmation', async () => {
    vi.mocked(apiEnableTotpMfa).mockResolvedValue({ success: false, error: 'Incorrect code' });
    render(<ForcedMfaSetupPage />);

    await enterPasswordAndContinue();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/auth/mfa/setup', expect.any(Object)));
    expect(screen.queryByTestId('enrollment-recovery-codes')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('confirm-totp'));
    await waitFor(() => expect(apiEnableTotpMfa).toHaveBeenCalledWith('123456', 'correct horse'));
    expect(commitMfaEnrollmentIfCurrent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('enrollment-recovery-codes')).not.toBeInTheDocument();
  });

  it.each([
    ['sms', apiEnableSmsMfa],
    ['passkey', apiEnrollPasskey],
  ] as const)('adopts the replacement session only after successful %s enrollment', async (method, terminal) => {
    vi.mocked(terminal).mockResolvedValue(replacement);
    vi.mocked(apiGetMfaEnrollmentOptions).mockResolvedValue(
      method === 'sms' ? options(false, true, false) : options(false, false, true),
    );
    render(<ForcedMfaSetupPage />);

    await enterPasswordAndContinue();

    await waitFor(() => expect(terminal).toHaveBeenCalledWith('correct horse'));
    expect(commitMfaEnrollmentIfCurrent).toHaveBeenCalledWith(1, replacement.tokens);
    expect(screen.getByTestId('enrollment-recovery-codes')).toHaveTextContent('RC-ONE');
    expect(navigateTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('enrollment-continue'));
    expect(navigateTo).toHaveBeenCalledWith('/');
  });

  it.each(['logout', 'replacement login'])('ignores a delayed enrollment response after %s', async () => {
    let resolveEnrollment!: (value: typeof replacement) => void;
    const delayed = new Promise<typeof replacement>((resolve) => { resolveEnrollment = resolve; });
    vi.mocked(apiEnableSmsMfa).mockReturnValue(delayed);
    vi.mocked(apiGetMfaEnrollmentOptions).mockResolvedValue(options(false, true, false));
    render(<ForcedMfaSetupPage />);

    await enterPasswordAndContinue();
    await waitFor(() => expect(apiEnableSmsMfa).toHaveBeenCalled());
    authState.sessionGeneration += 1;
    resolveEnrollment(replacement);

    await waitFor(() => expect(commitMfaEnrollmentIfCurrent).toHaveBeenCalledWith(1, replacement.tokens));
    expect(screen.queryByTestId('enrollment-recovery-codes')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enrollment-continue')).not.toBeInTheDocument();
  });
});
