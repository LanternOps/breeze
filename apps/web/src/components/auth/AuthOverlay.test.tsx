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
    // Reproduce the REAL production state: handleSessionExpired sets the reason
    // and then calls logout(), which flips isAuthenticated to false. That makes
    // the overlay's own `!isAuthenticated → redirectToLogin()` branch eligible,
    // and its soft navigateTo('/login') would race the hard
    // window.location.replace('/login?next=…&reason=…') — dropping both the
    // deep link and the expiry notice if it wins.
    const { navigateTo } = await import('../../lib/navigation');
    render(<AuthOverlay />);
    await fadeOverlayOut();
    vi.mocked(navigateTo).mockClear();

    act(() => {
      useAuthStore.setState({ sessionExpiredReason: 'session-expired' });
      useAuthStore.getState().logout();
    });

    await screen.findByTestId('session-expired-overlay');
    // Let the 10s safety-net window stay closed but flush any effect re-runs.
    await act(async () => {
      await Promise.resolve();
    });
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('still redirects a plain unauthenticated visitor to /login', async () => {
    // The positive counterpart to the two negative cases above: gating the
    // redirect branch on `!sessionExpiredReason` must not neuter it for the
    // ordinary "no session at all" visitor, who has no reason set and nothing
    // to recover from. Without this, the whole branch could be deleted and the
    // suite would stay green.
    const { navigateTo } = await import('../../lib/navigation');
    useAuthStore.setState({
      isAuthenticated: false,
      isLoading: false,
      tokens: null,
      user: null,
      sessionExpiredReason: null,
    });
    vi.mocked(navigateTo).mockClear();

    render(<AuthOverlay />);
    // Past the 50ms rehydrate delay, but well short of the 10s safety net — so
    // this asserts the main effect's redirect, not the timer's.
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });

    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('does not navigate from the 10s safety net once the expiry flow owns the redirect', async () => {
    // The safety net is the OTHER redirect path in this component: it fires on a
    // timer and reads the store directly, so a session that expires within 10s
    // of mount would otherwise have it soft-navigate to a bare /login and beat
    // handleSessionExpired's window.location.replace('/login?next=…&reason=…').
    const { navigateTo } = await import('../../lib/navigation');
    render(<AuthOverlay />);
    await fadeOverlayOut();
    vi.mocked(navigateTo).mockClear();

    act(() => {
      useAuthStore.setState({ sessionExpiredReason: 'idle' });
      useAuthStore.getState().logout();
    });
    await screen.findByTestId('session-expired-overlay');

    // Push well past the 10-second safety-net deadline.
    await act(async () => {
      vi.advanceTimersByTime(11_000);
      await Promise.resolve();
    });

    expect(navigateTo).not.toHaveBeenCalled();
  });
});
