import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  apiLogin: vi.fn(),
  login: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('../../stores/auth', () => {
  const useAuthStore = ((selector: (s: unknown) => unknown) =>
    selector({ user: { email: 'old@example.com' } })) as unknown as {
    (selector: (s: unknown) => unknown): unknown;
    getState: () => { login: typeof authMocks.login; updateUser: typeof authMocks.updateUser };
  };
  useAuthStore.getState = () => ({ login: authMocks.login, updateUser: authMocks.updateUser });

  return {
    fetchWithAuth: authMocks.fetchWithAuth,
    apiLogin: authMocks.apiLogin,
    useAuthStore,
  };
});

import AccountSetupStep from './AccountSetupStep';

const ok = () => ({ ok: true, json: async () => ({}) });
const trustResponse = (trustState: string) => ({
  ok: true,
  json: async () => ({ trustState }),
});
const trustCopy = 'Remote control and script execution unlock after your first card payment settles (about 24 hours) or once we have reviewed your account.';

describe('AccountSetupStep — partner trust onboarding copy', () => {
  beforeEach(() => {
    authMocks.fetchWithAuth.mockResolvedValue(trustResponse('trusted'));
  });

  it('shows the copy while the partner is on probation', async () => {
    authMocks.fetchWithAuth.mockResolvedValueOnce(trustResponse('probation'));

    render(<AccountSetupStep onNext={vi.fn()} />);

    expect(await screen.findByText(trustCopy)).toBeInTheDocument();
    expect(authMocks.fetchWithAuth).toHaveBeenCalledWith('/partner/trust');
  });

  it('hides the copy when the partner is trusted', async () => {
    render(<AccountSetupStep onNext={vi.fn()} />);

    await waitFor(() => expect(authMocks.fetchWithAuth).toHaveBeenCalledWith('/partner/trust'));
    expect(screen.queryByText(trustCopy)).not.toBeInTheDocument();
  });

  it('hides the copy when the trust request fails', async () => {
    authMocks.fetchWithAuth.mockRejectedValueOnce(new Error('network unavailable'));

    render(<AccountSetupStep onNext={vi.fn()} />);

    await waitFor(() => expect(authMocks.fetchWithAuth).toHaveBeenCalledWith('/partner/trust'));
    expect(screen.queryByText(trustCopy)).not.toBeInTheDocument();
  });
});

/**
 * An email change is only REQUESTED here: the API keeps the current address
 * until the link sent to the new one is opened, and the request does not end
 * the session. So the step never signs in with the new address or writes it to
 * the store; it tells the user to check their inbox. A password change in the
 * same submit runs FIRST, because a password change cancels a pending email
 * change.
 */
describe('AccountSetupStep — email change request', () => {
  const inboxMessage = 'Check your inbox at new@example.com and open the link to confirm your new address. Until then, keep signing in with your current address.';

  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.fetchWithAuth.mockResolvedValue(ok());
    authMocks.apiLogin.mockResolvedValue({
      success: true,
      user: { id: 'u-1', email: 'old@example.com' },
      tokens: { accessToken: 'a' },
    });
  });

  const calledPaths = () => authMocks.fetchWithAuth.mock.calls.map((call) => call[0]).filter((path) => path !== '/partner/trust');

  async function fill(user: ReturnType<typeof userEvent.setup>, opts: { email?: string; newPassword?: string }) {
    if (opts.email) await user.type(screen.getByLabelText(/email address/i), opts.email);
    await user.type(screen.getByLabelText(/current password/i), 'CurrentPass1!');
    if (opts.newPassword) {
      await user.type(screen.getByLabelText(/^new password/i), opts.newPassword);
      await user.type(screen.getByLabelText(/confirm/i), opts.newPassword);
    }
    await user.click(screen.getByRole('button', { name: /save & continue/i }));
  }

  it('requests the change, keeps the current address and session, and asks the user to check their inbox', async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await fill(user, { email: 'new@example.com' });

    expect(await screen.findByText(inboxMessage)).toBeInTheDocument();
    expect(authMocks.fetchWithAuth).toHaveBeenCalledWith('/users/me', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ email: 'new@example.com', currentPassword: 'CurrentPass1!' }),
    }));
    expect(authMocks.apiLogin).not.toHaveBeenCalled();
    expect(authMocks.updateUser).not.toHaveBeenCalled();

    // The message stays until the user moves on.
    await new Promise((r) => setTimeout(r, 700));
    expect(onNext).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('changes the password before requesting the email change, then sends the new password as the step-up', async () => {
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={vi.fn()} />);

    await fill(user, { email: 'new@example.com', newPassword: 'BrandNewPass1!' });

    expect(await screen.findByText(inboxMessage)).toBeInTheDocument();
    expect(calledPaths()).toEqual(['/auth/change-password', '/users/me']);
    // The password change ends the session: sign in again with the CURRENT address.
    expect(authMocks.apiLogin).toHaveBeenCalledTimes(1);
    expect(authMocks.apiLogin).toHaveBeenCalledWith('old@example.com', 'BrandNewPass1!');
    expect(authMocks.fetchWithAuth).toHaveBeenCalledWith('/users/me', expect.objectContaining({
      body: JSON.stringify({ email: 'new@example.com', currentPassword: 'BrandNewPass1!' }),
    }));
    expect(authMocks.updateUser).not.toHaveBeenCalled();
  });

  it('does not request the email change when the password change fails', async () => {
    authMocks.fetchWithAuth.mockImplementation(async (path: string) =>
      path === '/auth/change-password' ? { ok: false, json: async () => ({ error: 'Weak password' }) } : ok());
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await fill(user, { email: 'new@example.com', newPassword: 'BrandNewPass1!' });

    await waitFor(() => expect(calledPaths()).toEqual(['/auth/change-password']));
    expect(screen.queryByText(inboxMessage)).toBeNull();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('shows the error and stays on the step when the email request fails', async () => {
    authMocks.fetchWithAuth.mockImplementation(async (path: string) =>
      path === '/users/me' ? { ok: false, json: async () => ({ error: 'Address already in use' }) } : ok());
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await fill(user, { email: 'new@example.com' });

    expect(await screen.findByText('Address already in use')).toBeInTheDocument();
    expect(screen.queryByText(inboxMessage)).toBeNull();
    await new Promise((r) => setTimeout(r, 700));
    expect(onNext).not.toHaveBeenCalled();
  });

  it('says the password was changed when the email request then fails', async () => {
    authMocks.fetchWithAuth.mockImplementation(async (path: string) =>
      path === '/users/me' ? { ok: false, json: async () => ({ error: 'Address already in use' }) } : ok());
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await fill(user, { email: 'new@example.com', newPassword: 'BrandNewPass1!' });

    expect(await screen.findByText('Your password was changed. The email change could not be requested: Address already in use')).toBeInTheDocument();
    expect(calledPaths()).toEqual(['/auth/change-password', '/users/me']);
    expect(screen.queryByText(inboxMessage)).toBeNull();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('a password-only change signs in again with the current address and advances', async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await fill(user, { newPassword: 'BrandNewPass1!' });

    await waitFor(() => expect(onNext).toHaveBeenCalled(), { timeout: 2000 });
    expect(calledPaths()).toEqual(['/auth/change-password']);
    expect(authMocks.apiLogin).toHaveBeenCalledWith('old@example.com', 'BrandNewPass1!');
  });

  it('does NOT advance the wizard when the sign-in after a password change fails', async () => {
    authMocks.apiLogin.mockResolvedValue({ success: false });
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await fill(user, { email: 'new@example.com', newPassword: 'BrandNewPass1!' });

    await waitFor(() => expect(authMocks.apiLogin).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 700));
    expect(onNext).not.toHaveBeenCalled();
    expect(calledPaths()).toEqual(['/auth/change-password']);
  });
});

describe('AccountSetupStep — pending email change hint', () => {
  const hint = 'Your new address takes effect when you open the confirmation link sent to it. Signing out or changing your password before then cancels the email change.';

  beforeEach(() => {
    authMocks.fetchWithAuth.mockResolvedValue(trustResponse('trusted'));
  });

  it('says that signing out cancels the change once a new address is entered', async () => {
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={vi.fn()} />);

    expect(screen.queryByText(hint)).toBeNull();
    await user.type(screen.getByLabelText(/email address/i), 'new@example.com');

    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it('does not show the hint while the address is unchanged', async () => {
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={vi.fn()} />);

    await user.type(screen.getByLabelText(/email address/i), 'old@example.com');

    expect(screen.queryByText(hint)).toBeNull();
  });
});
