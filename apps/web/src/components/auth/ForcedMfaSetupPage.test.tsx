import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, createPasskeyCredentialMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  AuthSessionExpiredError: class extends Error {},
  ReauthenticationRequiredError: class extends Error {
    recoveryCodes?: readonly string[];
    constructor(codes?: readonly string[]) { super('reauthentication required'); this.recoveryCodes = codes; }
  },
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  restoreAccessTokenFromCookie: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: { updateUser: () => void }) => unknown) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ isAuthenticated: true, tokens: { accessToken: 'token' } }) },
  ),
}));

import ForcedMfaSetupPage from './ForcedMfaSetupPage';
import { ReauthenticationRequiredError } from '../../stores/auth';

const response = (body: unknown): Response => ({
  ok: true,
  status: 200,
  json: vi.fn().mockResolvedValue(body),
}) as unknown as Response;

describe('ForcedMfaSetupPage policy methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders SMS-only enrollment without a disallowed TOTP path', async () => {
    sessionStorage.setItem('breeze-mfa-enrollment-methods', JSON.stringify(['sms']));
    fetchWithAuthMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ success: true, recoveryCodes: [] }));
    render(<ForcedMfaSetupPage />);

    expect(await screen.findByLabelText('SMS codes')).toBeTruthy();
    expect(screen.queryByLabelText('Authenticator app')).toBeNull();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Phone number')).toBeTruthy();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/auth/mfa/setup', expect.anything());

    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+14155551234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send verification code' }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/auth/phone/verify',
      expect.objectContaining({ body: JSON.stringify({ phoneNumber: '+14155551234', currentPassword: 'password' }) }),
    ));

    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/auth/phone/confirm',
      expect.objectContaining({ body: JSON.stringify({ phoneNumber: '+14155551234', code: '123456', currentPassword: 'password' }) }),
    ));
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/auth/mfa/sms/enable',
      expect.objectContaining({ body: JSON.stringify({ currentPassword: 'password' }) }),
    );
  });

  it('uses the password-gated initial passkey registration flow for passkey-only policy', async () => {
    sessionStorage.setItem('breeze-mfa-enrollment-methods', JSON.stringify(['passkey']));
    fetchWithAuthMock
      .mockResolvedValueOnce(response({ options: { challenge: 'challenge' } }))
      .mockResolvedValueOnce(response({ recoveryCodes: [] }));
    createPasskeyCredentialMock.mockResolvedValueOnce({ id: 'credential', type: 'public-key', response: {} });
    render(<ForcedMfaSetupPage />);

    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/auth/passkeys/register/options',
      expect.objectContaining({ body: JSON.stringify({ currentPassword: 'password', name: 'Passkey' }) }),
    ));
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/auth/passkeys/register/verify',
      expect.objectContaining({ body: JSON.stringify({ name: 'Passkey', credential: { id: 'credential', type: 'public-key', response: {} } }) }),
    );
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/auth/mfa/setup', expect.anything());
  });

  it('shows terminal recovery codes once before navigating to login', async () => {
    sessionStorage.setItem('breeze-mfa-enrollment-methods', JSON.stringify(['passkey']));
    fetchWithAuthMock
      .mockResolvedValueOnce(response({ options: { challenge: 'challenge' } }))
      .mockRejectedValueOnce(new ReauthenticationRequiredError(['ABCD-EF12', 'WXYZ-9876']));
    createPasskeyCredentialMock.mockResolvedValueOnce({ id: 'credential', type: 'public-key', response: {} });
    render(<ForcedMfaSetupPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByTestId('signed-out-recovery-codes')).toBeTruthy();
    expect(screen.getAllByText('ABCD-EF12')).toHaveLength(1);
    expect(screen.getAllByText('WXYZ-9876')).toHaveLength(1);
  });

  it('acknowledges TOTP recovery codes after the server signs the session out', async () => {
    sessionStorage.setItem('breeze-mfa-enrollment-methods', JSON.stringify(['totp']));
    fetchWithAuthMock
      .mockResolvedValueOnce(response({ qrCodeDataUrl: 'data:image/png;base64,AA==', recoveryCodes: [] }))
      .mockRejectedValueOnce(new ReauthenticationRequiredError(['TOTP-0001', 'TOTP-0002']));
    render(<ForcedMfaSetupPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const codeInputs = await screen.findAllByRole('textbox');
    fireEvent.change(codeInputs[0], { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enable' }));

    expect(await screen.findByTestId('signed-out-recovery-codes')).toBeTruthy();
    expect(screen.getAllByText('TOTP-0001')).toHaveLength(1);
    expect(screen.getAllByText('TOTP-0002')).toHaveLength(1);
  });

  it('acknowledges SMS recovery codes after the server signs the session out', async () => {
    sessionStorage.setItem('breeze-mfa-enrollment-methods', JSON.stringify(['sms']));
    fetchWithAuthMock
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response({ success: true }))
      .mockRejectedValueOnce(new ReauthenticationRequiredError(['SMS0-0001', 'SMS0-0002']));
    render(<ForcedMfaSetupPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Phone number'), { target: { value: '+14155551234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send verification code' }));
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByTestId('signed-out-recovery-codes')).toBeTruthy();
    expect(screen.getAllByText('SMS0-0001')).toHaveLength(1);
    expect(screen.getAllByText('SMS0-0002')).toHaveLength(1);
  });
});
