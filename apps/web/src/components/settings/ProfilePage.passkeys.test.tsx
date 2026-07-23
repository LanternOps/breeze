import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, createPasskeyCredentialMock, mintAddFactorStepUpGrantMock, MockStepUpError } = vi.hoisted(() => {
  class MockStepUpError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'StepUpError';
      this.status = status;
    }
  }
  return {
    fetchWithAuthMock: vi.fn(),
    createPasskeyCredentialMock: vi.fn(),
    mintAddFactorStepUpGrantMock: vi.fn(),
    MockStepUpError,
  };
});

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  mintAddFactorStepUpGrant: mintAddFactorStepUpGrantMock,
  StepUpError: MockStepUpError,
  useAuthStore: Object.assign(
    (selector: any) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn() }) },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

// The Approval-security section loads its own approver devices on mount via the
// authenticator store; stub it so it doesn't consume from this file's ordered
// fetchWithAuth mock sequence. Its own behavior is covered by
// ApproverDevicesSection.test.tsx.
vi.mock('./ApproverDevicesSection', () => ({
  default: () => null,
}));

// ConnectSsoCard (#2183) fetches /sso/link/options on mount; stub it so it
// doesn't consume from this file's ordered fetchWithAuth mock sequence. Its own
// behavior is covered by ConnectSsoCard.test.tsx.
vi.mock('./ConnectSsoCard', () => ({
  default: () => null,
}));

import ProfilePage from './ProfilePage';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('ProfilePage passkey management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('starts passkey registration with password only when the account has no existing factor', async () => {
    const registrationOptions = {
      challenge: 'register-challenge',
      rp: { name: 'Breeze' },
      user: { id: 'user-1', name: 'casey@example.com', displayName: 'Casey Admin' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    };
    const credential = {
      id: 'credential-1',
      rawId: 'credential-1',
      type: 'public-key',
      response: {
        attestationObject: 'attestation',
        clientDataJSON: 'client-data',
      },
    };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ passkey: { id: 'credential-1', name: 'MacBook Touch ID' } }))
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }],
      }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
        }}
      />,
    );

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), {
      target: { value: 'MacBook Touch ID' },
    });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintAddFactorStepUpGrantMock).not.toHaveBeenCalled();
    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/register/options',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'current-password', name: 'MacBook Touch ID' }),
      }),
    ]);
    expect(createPasskeyCredentialMock).toHaveBeenCalledWith(registrationOptions);
    expect(fetchWithAuthMock.mock.calls[2]).toEqual([
      '/auth/passkeys/register/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'MacBook Touch ID', credential }),
      }),
    ]);
    await waitFor(() => expect(screen.getByText('MacBook Touch ID')).toBeTruthy());
  });

  it('mints a TOTP add_factor grant and sends stepUpGrantId when the account has TOTP MFA', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-2', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ passkey: { id: 'credential-2', name: 'Work laptop' } }))
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-2', name: 'Work laptop', lastUsedAt: null }],
      }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    mintAddFactorStepUpGrantMock.mockResolvedValueOnce('grant-123');

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
          mfaMethod: 'totp',
        }}
      />,
    );

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), {
      target: { value: 'Work laptop' },
    });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintAddFactorStepUpGrantMock).toHaveBeenCalledWith({ method: 'totp', code: '123456' });
    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/register/options',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          currentPassword: 'current-password',
          name: 'Work laptop',
          stepUpGrantId: 'grant-123',
        }),
      }),
    ]);
    expect(fetchWithAuthMock.mock.calls[2]).toEqual([
      '/auth/passkeys/register/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Work laptop',
          credential,
          stepUpGrantId: 'grant-123',
        }),
      }),
    ]);
  });

  it('uses an existing-passkey assertion for the step-up when a passkey is already registered', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-2', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'Old key', lastUsedAt: null }],
      }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ passkey: { id: 'credential-2', name: 'New key' } }))
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [
          { id: 'credential-1', name: 'Old key', lastUsedAt: null },
          { id: 'credential-2', name: 'New key', lastUsedAt: null },
        ],
      }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    mintAddFactorStepUpGrantMock.mockResolvedValueOnce('grant-456');

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
          mfaMethod: 'passkey',
        }}
      />,
    );

    await screen.findByText('Old key');
    await screen.findByTestId('passkey-stepup-passkey-note');
    fireEvent.change(screen.getByLabelText(/Passkey name/i), {
      target: { value: 'New key' },
    });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintAddFactorStepUpGrantMock).toHaveBeenCalledWith({ method: 'passkey' });
    expect(fetchWithAuthMock.mock.calls[1]?.[1]?.body).toContain('"stepUpGrantId":"grant-456"');
    expect(fetchWithAuthMock.mock.calls[2]?.[1]?.body).toContain('"stepUpGrantId":"grant-456"');
  });

  it('disables adding a passkey for SMS-method accounts and explains why', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
          mfaMethod: 'sms',
        }}
      />,
    );

    await screen.findByTestId('passkey-stepup-sms-note');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });

    const addButton = screen.getByRole('button', { name: 'Add passkey' }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(mintAddFactorStepUpGrantMock).not.toHaveBeenCalled();
  });

  it('offers the TOTP step-up immediately after enabling MFA in the same session', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ qrCodeDataUrl: 'data:image/png;base64,qr' }))
      .mockResolvedValueOnce(makeJsonResponse({ recoveryCodes: ['aaaa-bbbb'] }));

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: false,
        }}
      />,
    );

    await screen.findByText(/No passkeys are registered/i);
    // Unprotected account: no step-up input in the passkeys card.
    expect(screen.queryByTestId('passkey-stepup-code')).toBeNull();

    // Walk the TOTP enrollment flow: Enable → confirm password → code → enable.
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    fireEvent.change(document.getElementById('mfa-confirm-password')!, {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Verify and enable' });
    // The passkeys-card step-up input isn't mounted (tier still none), so the
    // only inputmode=numeric inputs are the six MFA digit boxes; typing into
    // the first spreads the full code across all six.
    const digitInputs = document.querySelectorAll('input[inputmode="numeric"]');
    fireEvent.change(digitInputs[0]!, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enable' }));
    await screen.findByText('Multi-factor authentication enabled successfully');

    // The account is now TOTP-protected — the passkeys card must offer the
    // add_factor step-up WITHOUT a page reload, or add-passkey 403s again.
    expect(await screen.findByTestId('passkey-stepup-code')).toBeTruthy();
  });

  it('shows a friendly error when the TOTP step-up code is rejected', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
    mintAddFactorStepUpGrantMock.mockRejectedValueOnce(new MockStepUpError('Invalid credentials', 401));

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
          mfaMethod: 'totp',
        }}
      />,
    );

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Incorrect authenticator code.');
    // The register endpoints are never called when the mint fails.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('sends currentPassword when deleting a passkey', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({
        passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }],
      }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true }));

    render(
      <ProfilePage
        initialUser={{
          id: 'user-1',
          name: 'Casey Admin',
          email: 'casey@example.com',
          mfaEnabled: true,
        }}
      />,
    );

    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await screen.findByText('Passkey deleted');

    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/credential-1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: 'current-password' }),
      }),
    ]);
  });
});
