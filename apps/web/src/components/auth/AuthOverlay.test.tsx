import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(async () => {}),
}));

import AuthOverlay from './AuthOverlay';
import { useAuthStore } from '../../stores/auth';

const AUTHENTICATED = {
  isAuthenticated: true,
  isLoading: false,
  tokens: { accessToken: 'access-token', expiresInSeconds: 900 },
  sessionExpiredReason: null,
} as const;

/**
 * Drives the overlay through its full mount → fade → unmount lifecycle so the
 * expiry mask is exercised from the state a real session actually expires in:
 * long after the initial overlay has faded out and started returning null.
 */
async function fadeOverlayOut(): Promise<void> {
  // The 50ms rehydrate delay, then the rAF that flips 'visible' → 'fading'.
  await act(async () => {
    vi.advanceTimersByTime(60);
  });
  const fadingOverlay = await waitFor(() => {
    const el = document.querySelector('.transition-opacity');
    if (!el) throw new Error('fade-out overlay not rendered');
    return el;
  });
  fireEvent.transitionEnd(fadingOverlay);
}

describe('AuthOverlay session-expiry mask', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAuthStore.setState(AUTHENTICATED);
  });

  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ ...AUTHENTICATED, isAuthenticated: false, tokens: null });
  });

  it('masks the page once a session expires, even after the overlay faded out', async () => {
    render(<AuthOverlay />);
    await fadeOverlayOut();
    expect(screen.queryByTestId('session-expired-overlay')).not.toBeInTheDocument();

    // handleSessionExpired() sets the reason, then guts the session.
    act(() => {
      useAuthStore.setState({ sessionExpiredReason: 'session-expired' });
      useAuthStore.getState().logout();
    });

    const mask = await screen.findByTestId('session-expired-overlay');
    expect(mask).toHaveTextContent(/Your session has expired/i);
  });

  it('masks the page for the idle reason too', async () => {
    render(<AuthOverlay />);
    await fadeOverlayOut();

    act(() => {
      useAuthStore.setState({ sessionExpiredReason: 'idle' });
      useAuthStore.getState().logout();
    });

    expect(await screen.findByTestId('session-expired-overlay')).toBeInTheDocument();
  });

  it('stays out of the way while the session is healthy', async () => {
    render(<AuthOverlay />);
    await fadeOverlayOut();

    expect(screen.queryByTestId('session-expired-overlay')).not.toBeInTheDocument();
    expect(document.querySelector('.transition-opacity')).toBeNull();
  });

  it('does not navigate — handleSessionExpired owns the redirect', async () => {
    const { navigateTo } = await import('../../lib/navigation');
    render(<AuthOverlay />);
    await fadeOverlayOut();
    vi.mocked(navigateTo).mockClear();

    act(() => {
      useAuthStore.setState({ sessionExpiredReason: 'session-expired' });
    });

    await screen.findByTestId('session-expired-overlay');
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
