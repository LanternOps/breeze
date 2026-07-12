import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, createPasskeyCredentialMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  apiCreateMfaStepUpGrant: vi.fn(),
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
import { apiCreateMfaStepUpGrant } from '../../stores/auth';

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

  it('starts passkey registration with currentPassword and verifies the browser credential', async () => {
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
          mfaEnabled: true,
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

  it('uses an existing TOTP factor grant instead of the password when adding a passkey', async () => {
    const registrationOptions = {
      challenge: 'register-challenge',
      rp: { name: 'Breeze' },
      user: { id: 'user-1', name: 'casey@example.com', displayName: 'Casey Admin' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    };
    const credential = { id: 'credential-2', type: 'public-key', response: {} };
    vi.mocked(apiCreateMfaStepUpGrant).mockResolvedValueOnce({ success: true, grant: 'g'.repeat(32) });
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'existing', name: 'Existing' }] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, reauthenticate: true }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(<ProfilePage initialUser={{
      id: 'user-1', name: 'Casey Admin', email: 'casey@example.com', mfaEnabled: true, mfaMethod: 'totp',
    }} />);

    await screen.findByText('Existing');
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'New key' } });
    fireEvent.change(screen.getByLabelText(/Existing MFA code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await waitFor(() => expect(apiCreateMfaStepUpGrant).toHaveBeenCalledWith('passkey.register', 'totp', '123456'));
    const grant = 'g'.repeat(32);
    expect(fetchWithAuthMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ mfaGrant: grant, name: 'New key' }),
    }));
    expect(fetchWithAuthMock.mock.calls[2][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ name: 'New key', credential, mfaGrant: grant }),
    }));
  });
});
