import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armSsoLoginGate,
  fetchWithAuth,
  handleSessionExpired,
  markSsoExchangeFailed,
  settleSsoLoginGate,
  SSO_EXCHANGE_FAILED_LOGIN_PATH,
  useAuthStore,
} from './auth';

// #3700 SSO login gate: while a `#ssoCode` exchange is (about to be) in
// flight, every refresh attempt must wait for it to settle. Without the gate,
// a sibling island's fetchWithAuth bootstrap fires /auth/refresh against the
// dead cookie of an enforce-SSO-locked-out user and hard-evicts to /login,
// abandoning the single-use grant mid-exchange.
describe('SSO login gate holds token refreshes (#3700)', () => {
  const originalFetch = global.fetch;
  let fetchCalls: string[];

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes('/auth/refresh')) {
        return new Response(
          JSON.stringify({ tokens: { accessToken: 'refreshed', expiresInSeconds: 900 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      tokens: null,
      user: { id: 'u-1', email: 'a@b.c', name: 'A', mfaEnabled: false },
      sessionExpiredReason: null,
    });
  });

  afterEach(() => {
    settleSsoLoginGate();
    global.fetch = originalFetch;
    useAuthStore.setState({ isAuthenticated: false, tokens: null, user: null });
    vi.restoreAllMocks();
  });

  it('defers the bootstrap refresh until the gate settles, then proceeds', async () => {
    armSsoLoginGate();

    const pending = fetchWithAuth('/config');

    // Give the held refresh every chance to fire while the gate is armed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls.filter((u) => u.includes('/auth/refresh'))).toHaveLength(0);

    settleSsoLoginGate();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(fetchCalls.some((u) => u.includes('/auth/refresh'))).toBe(true);
    expect(useAuthStore.getState().tokens?.accessToken).toBe('refreshed');
  });

  it('settleSsoLoginGate is a safe no-op when no gate is armed', () => {
    expect(() => settleSsoLoginGate()).not.toThrow();
  });
});

// #3704 second line of defence. Ordering (AuthOverlay awaits its redirect
// before settling the gate) is enough only while `navigateTo` completes a real
// Astro soft transition. Its fallback fires `window.location.replace` and
// returns immediately, having merely QUEUED a hard navigation — the address bar
// has not moved, so handleSessionExpired's `/login` pathname guard misses and
// the released refresh's eviction would overwrite the notice all over again.
// markSsoExchangeFailed makes the eviction land on the SAME url instead.
describe('a terminally failed SSO exchange outranks the generic expiry (#3704)', () => {
  // jsdom refuses a real navigation, so swap the whole location object (the
  // same trick stores/auth.test.ts uses) and spy on replace().
  function mockLocation(pathname: string, search = '') {
    const originalLocation = window.location;
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname, search, hash: '', replace, reload: vi.fn() },
    });
    return {
      replace,
      restore: () => {
        Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
      },
    };
  }

  const baseUser = { id: 'u-1', email: 'a@b.c', name: 'A', mfaEnabled: false };

  beforeEach(() => {
    // login() clears both the sessionExpiryInFlight latch and the SSO verdict,
    // which are module singletons that outlive an individual test.
    useAuthStore.getState().login(baseUser, { accessToken: 'a', expiresInSeconds: 900 });
  });

  afterEach(() => {
    useAuthStore.getState().login(baseUser, { accessToken: 'a', expiresInSeconds: 900 });
    useAuthStore.setState({ isAuthenticated: false, tokens: null, user: null });
  });

  it('evicts to the sso_exchange_failed notice instead of reason=session-expired', () => {
    const loc = mockLocation('/dashboard');
    try {
      markSsoExchangeFailed();
      handleSessionExpired('session-expired');

      expect(loc.replace).toHaveBeenCalledTimes(1);
      const target = String(loc.replace.mock.calls[0][0]);
      expect(target).toBe(SSO_EXCHANGE_FAILED_LOGIN_PATH);
      // The whole point: the generic reason must not be what the user reads.
      expect(target).not.toContain('reason=session-expired');
    } finally {
      loc.restore();
    }
  });

  it('leaves the ordinary expiry eviction untouched when no SSO exchange failed', () => {
    // The positive counterpart: without this, the branch above could swallow
    // every eviction and the suite would stay green.
    const loc = mockLocation('/dashboard');
    try {
      handleSessionExpired('session-expired');

      const target = String(loc.replace.mock.calls[0][0]);
      expect(target).toContain('reason=session-expired');
      expect(target).not.toContain('sso_exchange_failed');
    } finally {
      loc.restore();
    }
  });

  it('does not let a previous attempt\'s SSO verdict leak into the next session', () => {
    markSsoExchangeFailed();
    // A fresh login is a new session — it must not inherit the old verdict.
    useAuthStore.getState().login(baseUser, { accessToken: 'fresh', expiresInSeconds: 900 });

    const loc = mockLocation('/dashboard');
    try {
      handleSessionExpired('session-expired');
      expect(String(loc.replace.mock.calls[0][0])).toContain('reason=session-expired');
    } finally {
      loc.restore();
    }
  });
});
