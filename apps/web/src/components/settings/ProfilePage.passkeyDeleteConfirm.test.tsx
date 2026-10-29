import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('./TicketPushoverSettings', () => ({ default: () => null }));
vi.mock('./EmailNotificationSettings', () => ({ default: () => null }));
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
        mfaMethod: 'totp',
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });

    expect(screen.getByTestId('passkey-delete-confirm')).toBeInTheDocument();
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).startsWith('/auth/passkeys/credential-1'))).toBe(false);
  });

  it('warns that other sessions will be signed out, and names the passkey', async () => {
    seedOnePasskey();
    renderProfile();

    await screen.findByText('MacBook Touch ID');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/signs your other sessions out/i);
    expect(dialog.textContent).toContain('MacBook Touch ID');
  });

  it('sends the DELETE once the confirmation is accepted', async () => {
    seedOnePasskey();
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ stepUpGrantId: '20000000-0000-4000-8000-000000000009' }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ success: true, tokens: { accessToken: 'reissued', expiresInSeconds: 900 } }),
    );
    renderProfile();

    await screen.findByText('MacBook Touch ID');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText(/Current MFA code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('passkey-delete-confirm'));

    await screen.findByText('Passkey deleted');
    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/mfa/step-up',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ method: 'totp', code: '123456', operation: 'delete_passkey', passkeyId: 'credential-1' }),
      }),
    ]);
    expect(fetchWithAuthMock.mock.calls[2]).toEqual([
      '/auth/passkeys/credential-1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: 'current-password', stepUpGrantId: '20000000-0000-4000-8000-000000000009' }),
      }),
    ]);
  });

  it('asks for the password and current factor inside the named delete dialog', async () => {
    seedOnePasskey();
    renderProfile();
    await screen.findByText('MacBook Touch ID');
    expect(document.querySelector('#passkey-password')).toBeNull();
    expect(screen.queryByTestId('passkey-factor-code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('MacBook Touch ID');
    expect(dialog.contains(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }))).toBe(true);
    expect(dialog.contains(screen.getByTestId('passkey-factor-code'))).toBe(true);
    expect(screen.getByTestId('passkey-delete-confirm')).toBeDisabled();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    seedOnePasskey();
    renderProfile();

    await screen.findByText('MacBook Touch ID');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expect(screen.queryByTestId('passkey-delete-confirm')).not.toBeInTheDocument());
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).startsWith('/auth/passkeys/credential-1'))).toBe(false);
  });
  it('clears verification on cancel and binds a new dialog to the selected passkey', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [
      { id: 'first-key', name: 'First key', lastUsedAt: null },
      { id: 'second-key', name: 'Second key', lastUsedAt: null },
    ] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ stepUpGrantId: 'bound-grant' }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true }));
    renderProfile();
    await screen.findByText('First key');
    fireEvent.click(screen.getAllByTestId('passkey-delete')[0]);
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), { target: { value: 'discarded-password' } });
    fireEvent.change(screen.getByTestId('passkey-factor-code'), { target: { value: '111111' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('#passkey-password')).toBeNull();
    fireEvent.click(screen.getAllByTestId('passkey-delete')[1]);
    expect(screen.getByRole('dialog')).toHaveTextContent('Second key');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('First key');
    expect(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' })).toHaveValue('');
    expect(screen.getByTestId('passkey-factor-code')).toHaveValue('');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), { target: { value: 'current-password' } });
    fireEvent.change(screen.getByTestId('passkey-factor-code'), { target: { value: '222222' } });
    fireEvent.click(screen.getByTestId('passkey-delete-confirm'));
    await screen.findByText('Passkey deleted. Sign in again to continue.');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/auth/passkeys/second-key', expect.objectContaining({ method: 'DELETE' }));
    expect(fetchWithAuthMock.mock.calls.some(([url]) => url === '/auth/passkeys/first-key')).toBe(false);
  });

});
