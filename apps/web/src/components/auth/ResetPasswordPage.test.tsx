import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  apiResetPassword: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  apiResetPassword: authMocks.apiResetPassword,
}));

import ResetPasswordPage from './ResetPasswordPage';

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/reset-password?token=reset-token');
    authMocks.apiResetPassword.mockImplementation(async () => {
      expect(window.location.href).not.toContain('reset-token');
      return { success: true };
    });
  });

  it('scrubs the reset token before submitting it', async () => {
    render(<ResetPasswordPage />);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/reset-password');
      expect(window.location.search).toBe('');
    });

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'strong-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'strong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(authMocks.apiResetPassword).toHaveBeenCalledWith('reset-token', 'strong-password');
    });
  });
});
