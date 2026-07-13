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

/**
 * #2428: a committed email change advances auth_epoch and revokes every refresh
 * family — including THIS wizard's own session. The step must re-authenticate
 * with the new address before it does anything else, or it reports success and
 * then ejects the user on the next request.
 */
describe('AccountSetupStep — email change re-authenticates (#2428)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.fetchWithAuth.mockResolvedValue(ok());
    authMocks.apiLogin.mockResolvedValue({
      success: true,
      user: { id: 'u-1', email: 'new@example.com' },
      tokens: { accessToken: 'a' },
    });
  });

  async function submitEmailChange(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/current password/i), 'CurrentPass1!');
    await user.click(screen.getByRole('button', { name: /continue|save|next/i }));
  }

  it('re-authenticates with the NEW address after the email PATCH, then advances', async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await submitEmailChange(user);

    await waitFor(() => {
      expect(authMocks.fetchWithAuth).toHaveBeenCalledWith(
        '/users/me',
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    // The session the PATCH just killed is replaced before anything else runs.
    await waitFor(() => {
      expect(authMocks.apiLogin).toHaveBeenCalledWith('new@example.com', 'CurrentPass1!');
    });
    expect(authMocks.login).toHaveBeenCalled();

    await waitFor(() => expect(onNext).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('does NOT advance the wizard when the re-login fails (no false success)', async () => {
    const onNext = vi.fn();
    authMocks.apiLogin.mockResolvedValue({ success: false });
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await submitEmailChange(user);

    await waitFor(() => expect(authMocks.apiLogin).toHaveBeenCalled());
    expect(authMocks.login).not.toHaveBeenCalled();

    // Reporting success and moving on would strand the user on a dead session.
    await new Promise((r) => setTimeout(r, 50));
    expect(onNext).not.toHaveBeenCalled();
  });

  it('does not re-login when the email is unchanged (no needless round-trip)', async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    render(<AccountSetupStep onNext={onNext} />);

    await user.type(screen.getByLabelText(/current password/i), 'CurrentPass1!');
    await user.type(screen.getByLabelText(/^new password/i), 'BrandNewPass1!');
    await user.type(screen.getByLabelText(/confirm/i), 'BrandNewPass1!');
    await user.click(screen.getByRole('button', { name: /continue|save|next/i }));

    await waitFor(() => {
      expect(authMocks.fetchWithAuth).toHaveBeenCalledWith(
        '/auth/change-password',
        expect.objectContaining({ method: 'POST' })
      );
    });

    // No PATCH /users/me at all, and exactly one login — the password one.
    const patched = authMocks.fetchWithAuth.mock.calls.some((call) => call[0] === '/users/me');
    expect(patched).toBe(false);
    expect(authMocks.apiLogin).toHaveBeenCalledTimes(1);
    expect(authMocks.apiLogin).toHaveBeenCalledWith('old@example.com', 'BrandNewPass1!');
  });
});
