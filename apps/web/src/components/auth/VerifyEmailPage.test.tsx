import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  apiVerifyEmail: vi.fn(),
  login: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  apiVerifyEmail: authMocks.apiVerifyEmail,
  // VerifyEmailPage reads login via a selector: useAuthStore((s) => s.login).
  useAuthStore: (selector: (s: { login: typeof authMocks.login }) => unknown) =>
    selector({ login: authMocks.login }),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import VerifyEmailPage from './VerifyEmailPage';
import { navigateTo } from '../../lib/navigation';

describe('VerifyEmailPage (#6539 — confirm-step gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/verify-email?token=verify-token');
    authMocks.apiVerifyEmail.mockResolvedValue({ success: true, autoActivated: false });
  });

  it('does NOT consume the token on page load — a mail scanner that renders JS cannot verify the address', async () => {
    render(<VerifyEmailPage />);

    // The page settles on a Confirm button, and the token is untouched until a click.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm my email' })).toBeTruthy();
    });
    expect(authMocks.apiVerifyEmail).not.toHaveBeenCalled();
  });

  it('consumes the token only when the user clicks Confirm', async () => {
    render(<VerifyEmailPage />);

    const button = await screen.findByRole('button', { name: 'Confirm my email' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(authMocks.apiVerifyEmail).toHaveBeenCalledWith('verify-token');
    });
    // A successful consume lands on the "Email verified" state.
    await waitFor(() => {
      expect(screen.getByText('Email verified')).toBeTruthy();
    });
  });

  it('does not double-consume the token on a double click', async () => {
    render(<VerifyEmailPage />);
    const button = await screen.findByRole('button', { name: 'Confirm my email' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(authMocks.apiVerifyEmail).toHaveBeenCalledTimes(1);
    });
  });

  it('restores the server-held signup intent in sign-in recovery on a clean device', async () => {
    localStorage.clear();
    authMocks.apiVerifyEmail.mockResolvedValue({ success: false, status: 'sign_in', signupIntent: { intent: 'wisp' } });
    render(<VerifyEmailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm my email' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=' + encodeURIComponent('/billing/plans?intent=wisp'));
    expect(authMocks.login).not.toHaveBeenCalled();
  });

  it.each([[undefined], [{ intent: 'x' }]])('links plain /login when sign-in recovery carries no valid signup intent: %j', async (signupIntent) => {
    localStorage.clear();
    authMocks.apiVerifyEmail.mockResolvedValue({ success: false, status: 'sign_in', ...(signupIntent ? { signupIntent } : {}) });
    render(<VerifyEmailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm my email' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('logs in a verified signup and follows the server billing redirect without browser-held selection', async () => {
    localStorage.clear();
    authMocks.apiVerifyEmail.mockResolvedValue({ success: true, user: { id: 'new-user' }, tokens: { accessToken: 'new-token' }, redirectUrl: '/billing/plans' });
    render(<VerifyEmailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm my email' }));
    await waitFor(() => expect(authMocks.login).toHaveBeenCalledWith({ id: 'new-user' }, { accessToken: 'new-token' }));
    expect(navigateTo).toHaveBeenCalledWith('/billing/plans');
  });

  it('shows the no-token state and never calls the API when the URL has no token', async () => {
    window.history.replaceState({}, '', '/verify-email');
    render(<VerifyEmailPage />);

    await waitFor(() => {
      expect(screen.getByText('No verification token')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Confirm my email' })).toBeNull();
    expect(authMocks.apiVerifyEmail).not.toHaveBeenCalled();
  });
});
