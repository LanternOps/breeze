import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armSsoLoginGate,
  fetchWithAuth,
  settleSsoLoginGate,
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
