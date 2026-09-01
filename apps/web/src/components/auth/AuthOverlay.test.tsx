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

describe('AuthOverlay #ssoCode exchange bootstrap (#3700)', () => {
  const UNAUTHENTICATED = {
    isAuthenticated: false,
    isLoading: false,
    tokens: null,
    user: null,
    sessionExpiredReason: null,
  } as const;

  const originalFetch = global.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  function stubFetch(routes: Record<string, () => Response>) {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      for (const [needle, respond] of Object.entries(routes)) {
        if (url.includes(needle)) return respond();
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchCalls = [];
    useAuthStore.setState({ ...UNAUTHENTICATED });
    window.history.replaceState({}, '', '/');
  });

  afterEach(async () => {
    const { navigateTo } = await import('../../lib/navigation');
    vi.mocked(navigateTo).mockClear();
    global.fetch = originalFetch;
    vi.useRealTimers();
    useAuthStore.setState({ ...UNAUTHENTICATED });
    window.history.replaceState({}, '', '/');
  });

  it('trades the fragment grant for a session and strips it from the URL', async () => {
    stubFetch({
      '/sso/exchange': () => json(200, { accessToken: 'sso-access', expiresInSeconds: 900 }),
      '/users/me': () => json(200, { id: 'u-1', email: 'jhill@example.com', name: 'J Hill', mfaEnabled: false }),
    });
    window.history.replaceState({}, '', '/#ssoCode=grant-123');

    render(<AuthOverlay />);
    // The fragment must be stripped synchronously on consumption — before the
    // async exchange settles — so a reload can't replay the single-use grant.
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(window.location.hash).toBe('');

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });
    expect(useAuthStore.getState().tokens?.accessToken).toBe('sso-access');

    const exchange = fetchCalls.find((c) => c.url.includes('/sso/exchange'));
    expect(exchange).toBeDefined();
    expect(JSON.parse(String(exchange!.init?.body))).toEqual({ code: 'grant-123' });

    const { navigateTo } = await import('../../lib/navigation');
    expect(navigateTo).not.toHaveBeenCalledWith(expect.stringContaining('/login'), expect.anything());
  });

  it('bounces to /login with an error notice when the exchange is rejected', async () => {
    stubFetch({
      '/sso/exchange': () => json(400, { error: 'Invalid or expired token exchange code' }),
    });
    window.history.replaceState({}, '', '/#ssoCode=stale-grant');
    const { navigateTo } = await import('../../lib/navigation');
    vi.mocked(navigateTo).mockClear();

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledWith('/login?error=sso_exchange_failed', { replace: true });
    });
    expect(window.location.hash).toBe('');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    // The error-carrying redirect must be the ONLY navigation — the generic
    // bare-/login branch would strip the notice if it raced and won.
    expect(vi.mocked(navigateTo)).toHaveBeenCalledTimes(1);
  });

  it('strips a leftover grant without exchanging when a live session already exists', async () => {
    stubFetch({});
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      tokens: { accessToken: 'live-token', expiresInSeconds: 900 },
      sessionExpiredReason: null,
    });
    window.history.replaceState({}, '', '/#ssoCode=old-grant');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
      await Promise.resolve();
    });

    expect(window.location.hash).toBe('');
    expect(fetchCalls).toHaveLength(0);
    expect(useAuthStore.getState().tokens?.accessToken).toBe('live-token');
  });
});

describe('AuthOverlay #ssoCode failure and race hardening (#3700 review round)', () => {
  const UNAUTHENTICATED = {
    isAuthenticated: false,
    isLoading: false,
    tokens: null,
    user: null,
    sessionExpiredReason: null,
  } as const;

  const originalFetch = global.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      for (const [needle, respond] of Object.entries(routes)) {
        if (url.includes(needle)) return respond();
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function expectErrorBounce() {
    const { navigateTo } = await import('../../lib/navigation');
    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledWith('/login?error=sso_exchange_failed', { replace: true });
    });
    expect(window.location.hash).toBe('');
    expect(vi.mocked(navigateTo)).toHaveBeenCalledTimes(1);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchCalls = [];
    useAuthStore.setState({ ...UNAUTHENTICATED });
    window.history.replaceState({}, '', '/');
    const { navigateTo } = await import('../../lib/navigation');
    vi.mocked(navigateTo).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    vi.useRealTimers();
    useAuthStore.setState({ ...UNAUTHENTICATED });
    window.history.replaceState({}, '', '/');
  });

  it('bounces a malformed grant to /login with the error notice, without attempting an exchange', async () => {
    stubFetch({});
    window.history.replaceState({}, '', '/#ssoCode=%E0%A4%A');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await expectErrorBounce();
    expect(fetchCalls).toHaveLength(0);
  });

  it('bounces an empty grant to /login with the error notice', async () => {
    stubFetch({});
    window.history.replaceState({}, '', '/#ssoCode=');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await expectErrorBounce();
    expect(fetchCalls).toHaveLength(0);
  });

  it('bounces to /login with the error notice when /users/me fails after a successful exchange', async () => {
    stubFetch({
      '/sso/exchange': () => json(200, { accessToken: 'sso-access', expiresInSeconds: 900 }),
      '/users/me': () => json(500, { error: 'boom' }),
    });
    window.history.replaceState({}, '', '/#ssoCode=grant-1');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await expectErrorBounce();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('bounces cleanly when /users/me returns 200 with a non-JSON body (no unhandled rejection)', async () => {
    stubFetch({
      '/sso/exchange': () => json(200, { accessToken: 'sso-access', expiresInSeconds: 900 }),
      '/users/me': () =>
        new Response('<html>gateway interstitial</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    });
    window.history.replaceState({}, '', '/#ssoCode=grant-2');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await expectErrorBounce();
  });

  it('bounces with the error notice when the exchange request itself throws (offline)', async () => {
    stubFetch({
      '/sso/exchange': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    window.history.replaceState({}, '', '/#ssoCode=grant-3');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await expectErrorBounce();
  });

  it('completes the exchange for a stale persisted session with a dead refresh cookie, without an eviction race', async () => {
    // The enforce-SSO lockout arrival state: localStorage still says
    // isAuthenticated (tokens are memory-only), the refresh cookie is dead,
    // and a fresh grant is in the fragment. The dead-cookie refresh must not
    // fire from the slow path and evict mid-exchange.
    let exchangeSettled = false;
    stubFetch({
      '/auth/refresh': () => {
        if (!exchangeSettled) throw new Error('refresh raced the SSO exchange');
        return json(401, { error: 'invalid refresh token' });
      },
      '/sso/exchange': async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        exchangeSettled = true;
        return json(200, { accessToken: 'sso-access', expiresInSeconds: 900 });
      },
      '/users/me': () => json(200, { id: 'u-9', email: 'locked@example.com', name: 'Locked Out', mfaEnabled: false }),
    });
    useAuthStore.setState({
      ...UNAUTHENTICATED,
      isAuthenticated: true,
      user: { id: 'u-9', email: 'locked@example.com', name: 'Locked Out', mfaEnabled: false },
    });
    window.history.replaceState({}, '', '/#ssoCode=grant-4');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    await waitFor(() => {
      expect(useAuthStore.getState().tokens?.accessToken).toBe('sso-access');
    });
    const { navigateTo } = await import('../../lib/navigation');
    expect(navigateTo).not.toHaveBeenCalled();
    expect(fetchCalls.some((c) => c.url.includes('/auth/refresh') && !exchangeSettled)).toBe(false);
  });
});

// Issue #3696. When POST /auth/refresh is rate-limited the session is FINE —
// the server is rationing, not judging the refresh cookie. Two failure modes
// had to die here:
//
//  1. the hard logout: `restoreAccessTokenFromCookie()` collapsed every
//     non-success into a bare soft `navigateTo('/login')`;
//  2. the SILENT one, which the reporter called worse: DashboardLayout mounts
//     Sidebar/Header/page content as ungated siblings of this overlay, so the
//     page painted its full chrome with every data call 401'd, no error and no
//     toast — indistinguishable from "you have no integrations configured".
//
// The throttle mask closes both: the session is untouched and the page can
// never render as loaded-but-empty.
describe('AuthOverlay refresh-throttle mask (#3696)', () => {
  const THROTTLED_BASE = {
    isAuthenticated: true,
    isLoading: false,
    tokens: null,
    user: null,
    sessionExpiredReason: null,
    authThrottledUntil: null as number | null,
  };

  // jsdom's `location.reload` is non-configurable, so the whole location object
  // is swapped (the same trick stores/auth.test.ts uses) rather than patched.
  const originalLocation = window.location;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/integrations', search: '', hash: '', href: '/integrations', replace: vi.fn(), assign: vi.fn(), reload },
    });
    useAuthStore.setState({ ...THROTTLED_BASE });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    useAuthStore.setState({ ...THROTTLED_BASE, isAuthenticated: false, authThrottledUntil: null });
  });

  it('masks the page while throttled, and says the user is still signed in', async () => {
    useAuthStore.setState({ authThrottledUntil: Date.now() + 30_000 });
    render(<AuthOverlay />);

    const mask = await screen.findByTestId('auth-throttled-overlay');
    // The copy must NOT claim the session expired — it had not.
    expect(mask).not.toHaveTextContent(/expired/i);
    expect(mask).toHaveTextContent(/still signed in/i);
    expect(screen.queryByTestId('session-expired-overlay')).not.toBeInTheDocument();
  });

  it('does not bounce to /login while throttled — including past the 10s safety timer', async () => {
    useAuthStore.setState({ authThrottledUntil: Date.now() + 45_000 });
    render(<AuthOverlay />);
    await screen.findByTestId('auth-throttled-overlay');

    // The safety net force-redirects to /login after 10s whenever no access
    // token exists. A rate-limit window is legitimately longer than that, so
    // leaving it armed would reinstate exactly the forced logout this fixes.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    const { navigateTo } = await import('../../lib/navigation');
    expect(navigateTo).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(screen.getByTestId('auth-throttled-overlay')).toBeInTheDocument();
  });

  it('offers a manual retry and a sign-out escape hatch', async () => {
    useAuthStore.setState({ authThrottledUntil: Date.now() + 30_000 });
    render(<AuthOverlay />);
    await screen.findByTestId('auth-throttled-overlay');

    fireEvent.click(screen.getByTestId('auth-throttled-retry'));
    expect(reload).toHaveBeenCalled();

    // Signing out must be available but never automatic — deciding to sign the
    // user out is the whole bug.
    expect(screen.getByTestId('auth-throttled-signout')).toBeInTheDocument();
  });

  // #3984: the mask's own countdown used to end in its OWN
  // `window.location.reload()` — racing the auth store's own retry-in-progress
  // at the exact same deadline (both derived from `authThrottledUntil`), and
  // the mask's reload usually preempted the store's retry, wasting it. The
  // mask is now pure display: its countdown reaching zero must NOT itself
  // trigger a reload. The store is the single owner of automatic recovery
  // (`scheduleThrottleReload`, covered in stores/auth.test.ts) — a state
  // update made directly via `setState`, as this test does, never goes
  // through the store's throttle-wait path, so no reload is ever scheduled
  // here either.
  it('does not reload on its own once the advertised window elapses — the store owns recovery', async () => {
    useAuthStore.setState({ authThrottledUntil: Date.now() + 2_000 });
    render(<AuthOverlay />);
    await screen.findByTestId('auth-throttled-overlay');
    expect(reload).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    expect(reload).not.toHaveBeenCalled();
    // The countdown itself still renders correctly at zero.
    expect(screen.getByTestId('auth-throttled-overlay')).toHaveTextContent(/Retrying in 0s/i);
  });

  // THE branch-order regression. The throttle mask is checked BEFORE the
  // `fadeState === 'hidden'` early return for the same reason the expiry mask
  // is: by the time a mid-session refresh gets throttled, this overlay has long
  // since faded out and started returning null. Move the branch below that
  // return and the page renders as fully-painted-but-empty — symptom (b) of
  // #3696, the one the reporter called worse than the logout because it isn't
  // self-evident. Every other test here starts with tokens: null, so the fade
  // lifecycle never runs and none of them can catch that reordering.
  it('masks the page when a throttle arrives AFTER the overlay already faded out', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      tokens: { accessToken: 'access-token', expiresInSeconds: 900 },
      isLoading: false,
      sessionExpiredReason: null,
      authThrottledUntil: null,
    });
    render(<AuthOverlay />);

    // Drive it all the way to fadeState === 'hidden' (renders null).
    await fadeOverlayOut();
    expect(screen.queryByTestId('auth-throttled-overlay')).not.toBeInTheDocument();

    // Now a background refresh gets rate-limited mid-session.
    act(() => {
      useAuthStore.setState({ tokens: null, authThrottledUntil: Date.now() + 30_000 });
    });

    expect(await screen.findByTestId('auth-throttled-overlay')).toBeInTheDocument();
  });

  // The mirror image of the test above, and the one the first cut of this fix
  // got wrong. A throttle does NOT imply the session lost its access token:
  // AdminSessionManager fires a keepalive refresh on an interval while the user
  // is authenticated, so a 429 routinely lands while the token is still valid
  // and every data call is still succeeding. Masking there is wrong twice over
  // — it hides a working page, and AuthThrottledMask's countdown ends in
  // `window.location.reload()`, so it would discard unsaved work to "recover" a
  // session that was never impaired.
  it('does NOT mask, or reload, when a throttle arrives while the access token is still valid', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      tokens: { accessToken: 'access-token', expiresInSeconds: 900 },
      isLoading: false,
      sessionExpiredReason: null,
      authThrottledUntil: null,
    });
    render(<AuthOverlay />);
    await fadeOverlayOut();

    // Keepalive refresh gets rate-limited. The token is untouched.
    act(() => {
      useAuthStore.setState({ authThrottledUntil: Date.now() + 30_000 });
    });

    expect(screen.queryByTestId('auth-throttled-overlay')).not.toBeInTheDocument();

    // Run past the retry deadline: the mask never mounted, so its countdown
    // must never have armed the reload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });

    expect(screen.queryByTestId('auth-throttled-overlay')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('lets a real expiry win over a stale throttle', async () => {
    useAuthStore.setState({
      authThrottledUntil: Date.now() + 30_000,
      sessionExpiredReason: 'session-expired',
    });
    render(<AuthOverlay />);

    // A genuinely dead session must still get its redirecting mask; the
    // throttle must never mask an eviction that is already under way.
    expect(await screen.findByTestId('session-expired-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-throttled-overlay')).not.toBeInTheDocument();
  });
});
