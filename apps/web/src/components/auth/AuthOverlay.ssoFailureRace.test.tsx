import { render, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(async () => {}),
}));

import AuthOverlay from './AuthOverlay';
import { useAuthStore } from '../../stores/auth';
import * as authStoreModule from '../../stores/auth';

// Deliberately a FILE of its own rather than another block in
// AuthOverlay.test.tsx: these cases assert that a refresh queued behind the SSO
// gate really does reach the network once the gate opens, and the auth store's
// refresh de-duplication (`tokenRefreshInFlight`) is module-level state that the
// throttle suite in AuthOverlay.test.tsx leaves parked on a promise its fake
// timers never resolve. Sharing a file makes these tests read green-or-red on
// that leftover instead of on the behaviour under test; vitest's per-file module
// isolation removes the coupling.

// Issue #3704. #3700 gave a failed SSO exchange its own notice
// (`/login?error=sso_exchange_failed`) and #3702 shipped the copy — but on the
// failure path the user still read "Your session expired", which points away
// from SSO and invites an infinite retry loop.
//
// The cause is an ordering bug, not a missing feature: `navigateTo` is an
// ASYNC page transition, so issuing it un-awaited and settling the SSO gate on
// the next line releases every queued refresh while the redirect is still in
// flight. Those refreshes 401 against the same dead cookie, and
// `handleSessionExpired`'s `window.location.replace(…&reason=session-expired)`
// is a HARD navigation: it aborts the soft one and overwrites the URL.
//
// The fix is to settle the gate only once the redirect has COMMITTED. By then
// the address bar is on /login, where `handleSessionExpired`'s own pathname
// guard makes its redirect a no-op — so the specific reason survives.
describe('AuthOverlay SSO failure redirect vs. refresh eviction (#3704)', () => {
  // The enforce-SSO lockout arrival state: localStorage still says
  // authenticated (tokens are memory-only), the refresh cookie is dead.
  const STALE_SESSION = {
    isAuthenticated: true,
    isLoading: false,
    tokens: null,
    user: { id: 'u-7', email: 'locked@example.com', name: 'Locked Out', mfaEnabled: false },
    sessionExpiredReason: null,
    authThrottledUntil: null as number | null,
  };

  const originalFetch = global.fetch;
  let fetchCalls: string[];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      for (const [needle, respond] of Object.entries(routes)) {
        if (url.includes(needle)) return respond();
      }
      return json(200, {});
    }) as typeof fetch;
  }

  const refreshCalls = () => fetchCalls.filter((u) => u.includes('/auth/refresh'));

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchCalls = [];
    useAuthStore.setState({ ...STALE_SESSION });
    window.history.replaceState({}, '', '/');
    const { navigateTo } = await import('../../lib/navigation');
    vi.mocked(navigateTo).mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    authStoreModule.settleSsoLoginGate();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    vi.useRealTimers();
    useAuthStore.setState({ ...STALE_SESSION, isAuthenticated: false, user: null });
    window.history.replaceState({}, '', '/');
    const { navigateTo } = await import('../../lib/navigation');
    vi.mocked(navigateTo).mockImplementation(async () => {});
  });

  it('holds the gated refresh until the sso_exchange_failed redirect has committed', async () => {
    const { navigateTo } = await import('../../lib/navigation');
    let commitNavigation!: () => void;
    const navigationCommitted = new Promise<void>((resolve) => {
      commitNavigation = resolve;
    });
    // A real astro transition resolves only once the address bar is already on
    // the destination. Model exactly that: the URL moves when — and not before
    // — the navigation promise settles.
    vi.mocked(navigateTo).mockImplementation(async (path: string) => {
      await navigationCommitted;
      window.history.replaceState({}, '', path);
    });

    stubFetch({
      '/sso/exchange': () => json(400, { error: 'Invalid or expired token exchange code' }),
      '/auth/refresh': () => json(401, { error: 'invalid refresh token' }),
    });

    authStoreModule.armSsoLoginGate();
    // A sibling island's bootstrap fetch, queued behind the gate. Its 401 is
    // the eviction that overwrote the URL on main.
    const gatedRequest = authStoreModule.fetchWithAuth('/config').catch(() => null);
    window.history.replaceState({}, '', '/#ssoCode=stale-grant');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledWith('/login?error=sso_exchange_failed', { replace: true });
    });

    // THE REGRESSION: while the redirect is still in flight the gate must stay
    // shut. On main it settled on the very next line, the queued refresh 401'd,
    // and handleSessionExpired's hard replace won the race.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(refreshCalls()).toHaveLength(0);
    expect(useAuthStore.getState().sessionExpiredReason).toBeNull();

    commitNavigation();
    await act(async () => {
      await navigationCommitted;
      vi.advanceTimersByTime(50);
    });

    // Released now — and the eviction it triggers finds the address bar
    // already on /login, so handleSessionExpired leaves the SSO reason alone.
    await waitFor(() => {
      expect(refreshCalls().length).toBeGreaterThan(0);
    });
    await act(async () => {
      await gatedRequest;
    });
    expect(window.location.pathname).toBe('/login');
    expect(window.location.search).toBe('?error=sso_exchange_failed');
  });

  it('holds the gate for a malformed grant too, whose bounce skips the exchange entirely', async () => {
    const { navigateTo } = await import('../../lib/navigation');
    let commitNavigation!: () => void;
    const navigationCommitted = new Promise<void>((resolve) => {
      commitNavigation = resolve;
    });
    vi.mocked(navigateTo).mockImplementation(async (path: string) => {
      await navigationCommitted;
      window.history.replaceState({}, '', path);
    });

    stubFetch({ '/auth/refresh': () => json(401, { error: 'invalid refresh token' }) });

    authStoreModule.armSsoLoginGate();
    const gatedRequest = authStoreModule.fetchWithAuth('/config').catch(() => null);
    // Truncated link: the grant is present but its percent-encoding is broken,
    // so there is no exchange to lose the race to — only the redirect.
    window.history.replaceState({}, '', '/#ssoCode=%E0%A4%A');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledWith('/login?error=sso_exchange_failed', { replace: true });
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(refreshCalls()).toHaveLength(0);

    commitNavigation();
    await act(async () => {
      await navigationCommitted;
      vi.advanceTimersByTime(50);
    });
    await waitFor(() => {
      expect(refreshCalls().length).toBeGreaterThan(0);
    });
    await act(async () => {
      await gatedRequest;
    });
    expect(window.location.search).toBe('?error=sso_exchange_failed');
  });

  it('still settles the gate when the redirect itself throws — a queued refresh is never stranded', async () => {
    // Waiting on the navigation must not become a new way to deadlock: if
    // navigateTo rejects (its own window.location fallback unavailable), the
    // queued refreshes must still be released rather than hang until the
    // gate's 15s timeout backstop.
    const { navigateTo } = await import('../../lib/navigation');
    vi.mocked(navigateTo).mockRejectedValue(new Error('navigation unavailable'));

    stubFetch({
      '/sso/exchange': () => json(400, { error: 'Invalid or expired token exchange code' }),
      '/auth/refresh': () => json(401, { error: 'invalid refresh token' }),
    });

    authStoreModule.armSsoLoginGate();
    const gatedRequest = authStoreModule.fetchWithAuth('/config').catch(() => null);
    window.history.replaceState({}, '', '/#ssoCode=stale-grant');

    render(<AuthOverlay />);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });

    // Well inside SSO_LOGIN_GATE_TIMEOUT_MS (15s) — the release has to come
    // from the redirect path settling the gate, not from the timeout.
    await waitFor(() => {
      expect(refreshCalls().length).toBeGreaterThan(0);
    });
    await act(async () => {
      await gatedRequest;
    });
  });
});
