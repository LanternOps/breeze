import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  apiLogin: vi.fn(),
  fetchWithAuth: vi.fn(),
  login: vi.fn(),
  currentInstalledSession: vi.fn(() => true),
  user: { id: 'user-a', email: 'a@example.com', name: 'A', mfaEnabled: false },
}));

vi.mock('../../stores/auth', () => ({
  apiLogin: authMocks.apiLogin,
  fetchWithAuth: authMocks.fetchWithAuth,
  isInstalledAuthSessionCurrent: authMocks.currentInstalledSession,
  StaleWebSessionError: class StaleWebSessionError extends Error {},
  useAuthStore: Object.assign(
    (selector: (state: { user: typeof authMocks.user }) => unknown) => selector({ user: authMocks.user }),
    { getState: () => ({ login: authMocks.login, updateUser: vi.fn() }) },
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import AccountSetupStep from './AccountSetupStep';

describe('AccountSetupStep session boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.fetchWithAuth.mockResolvedValue({ ok: true, json: vi.fn() });
    authMocks.apiLogin.mockResolvedValue({
      success: true,
      user: authMocks.user,
      tokens: { accessToken: 'access-a', expiresInSeconds: 900 },
      installedSession: { generation: 1, userId: 'user-a', accessToken: 'access-a' },
    });
  });

  it('does not reinstall or advance after account A relogin is superseded by B', async () => {
    authMocks.currentInstalledSession
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const onNext = vi.fn();
    render(<AccountSetupStep onNext={onNext} />);

    fireEvent.input(screen.getByLabelText('setup.account.currentPassword'), { target: { value: 'OldPass123!' } });
    fireEvent.input(screen.getByLabelText('setup.account.newPassword'), { target: { value: 'NewPass123!' } });
    fireEvent.input(screen.getByLabelText('setup.account.confirmNewPassword'), { target: { value: 'NewPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'setup.common.saveAndContinue' }));

    await waitFor(() => expect(authMocks.apiLogin).toHaveBeenCalledOnce());
    expect(authMocks.login).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(onNext).not.toHaveBeenCalled();
  });
});
