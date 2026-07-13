import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  apiRegister: vi.fn(),
  currentInstalledSession: vi.fn(() => true),
}));

vi.mock('../../stores/auth', () => ({
  apiRegister: authMocks.apiRegister,
  isInstalledAuthSessionCurrent: authMocks.currentInstalledSession,
}));

vi.mock('../../lib/navigation', () => ({ navigateTo: vi.fn() }));

import { navigateTo } from '../../lib/navigation';
import RegisterPage from './RegisterPage';

describe('RegisterPage session boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.currentInstalledSession.mockReturnValue(true);
  });

  it('suppresses navigation when a newer session replaces the registered account', async () => {
    authMocks.apiRegister.mockResolvedValueOnce({
      success: true,
      user: { id: 'user-a' },
      tokens: { accessToken: 'access-a' },
      installedSession: { generation: 1, userId: 'user-a', accessToken: 'access-a' },
    });
    authMocks.currentInstalledSession.mockReturnValue(false);
    render(<RegisterPage />);

    fireEvent.input(screen.getByLabelText(/^name$/i), { target: { value: 'Account A' } });
    fireEvent.input(screen.getByLabelText(/email/i), { target: { value: 'a@example.com' } });
    fireEvent.input(screen.getAllByLabelText(/^password$/i)[0]!, { target: { value: 'StrongPass123!' } });
    fireEvent.input(screen.getByLabelText(/confirm password/i), { target: { value: 'StrongPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(authMocks.apiRegister).toHaveBeenCalledOnce());
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
