import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, createPasskeyCredentialMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  createPasskeyCredentialMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  useAuthStore: Object.assign(
    (selector: any) => selector({ updateUser: vi.fn() }),
    { getState: () => ({ updateUser: vi.fn(), sessionGeneration: 0, commitReissuedSessionIfCurrent: vi.fn(() => true) }) },
  ),
}));

vi.mock('@/lib/avatarBlobCache', () => ({
  useAvatarBlobUrl: (url: string | null | undefined) => url ?? null,
}));

vi.mock('./ApproverDevicesSection', () => ({ default: () => null }));
vi.mock('./ConnectSsoCard', () => ({ default: () => null }));

import ProfilePage from './ProfilePage';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const renderProfile = () =>
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

const seedOnePasskey = () => {
  fetchWithAuthMock.mockResolvedValueOnce(
    makeJsonResponse({ passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }] }),
  );
};

// #5314: deleting a passkey removes an MFA factor and bumps `mfa_epoch`, which
// signs the account's other sessions out. That was a single unguarded click.
describe('ProfilePage passkey delete confirmation (#5314)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('does not send the DELETE on the first click — it asks first', async () => {
    seedOnePasskey();
    renderProfile();

    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByTestId('passkey-delete-confirm')).toBeInTheDocument();
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).startsWith('/auth/passkeys/credential-1'))).toBe(false);
  });

  it('warns that other sessions will be signed out, and names the passkey', async () => {
    seedOnePasskey();
    renderProfile();

    await screen.findByText('MacBook Touch ID');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/signs your other sessions out/i);
    expect(dialog.textContent).toContain('MacBook Touch ID');
  });

  it('sends the DELETE once the confirmation is accepted', async () => {
    seedOnePasskey();
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ success: true, tokens: { accessToken: 'reissued', expiresInSeconds: 900 } }),
    );
    renderProfile();

    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByTestId('passkey-delete-confirm'));

    await screen.findByText('Passkey deleted');
    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/credential-1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: 'current-password' }),
      }),
    ]);
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    seedOnePasskey();
    renderProfile();

    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expect(screen.queryByTestId('passkey-delete-confirm')).not.toBeInTheDocument());
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).startsWith('/auth/passkeys/credential-1'))).toBe(false);
  });
});
