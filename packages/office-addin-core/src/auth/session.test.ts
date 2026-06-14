import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthBlockedError,
  InvalidEntraTokenError,
  __resetSessionForTests,
  clearSession,
  getSessionToken,
  getStoredSession,
  reExchange,
  signIn,
} from './session';
import type { EntraTokenDeps } from './entraToken';

const OK_BODY = {
  accessToken: 'breeze-session-token-48ch',
  expiresInSeconds: 86400,
  user: { id: 'u-1', email: 'finance.user@contoso.com', name: 'Finance User' },
};

function entra(token = 'entra-token'): EntraTokenDeps {
  return { getSsoToken: vi.fn(async () => token), getMsalToken: vi.fn(async () => token) };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  __resetSessionForTests();
});

describe('signIn', () => {
  it('exchanges the Entra token and stores the session in memory + sessionStorage', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const session = await signIn({ interactive: false }, { entra: entra(), fetchImpl });
    expect(session.user.email).toBe('finance.user@contoso.com');
    expect(getSessionToken()).toBe('breeze-session-token-48ch');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/client-ai/auth/exchange');
    expect(JSON.parse(init.body as string)).toEqual({ accessToken: 'entra-token' });
    expect(sessionStorage.getItem('breeze-client-ai-session')).toContain('breeze-session-token-48ch');
  });

  it('maps exchange error codes to block kinds', async () => {
    const cases: Array<[number, string, string]> = [
      [404, 'tenant_not_provisioned', 'not_provisioned'],
      [404, 'not_enabled', 'not_provisioned'],
      [403, 'disabled', 'disabled'],
      [403, 'user_not_permitted', 'user_not_permitted'],
      [403, 'account_inactive', 'account_inactive'],
      [403, 'provisioning_failed', 'retryable'],
      [429, 'rate_limited', 'retryable'],
      [503, 'service_unavailable', 'retryable'],
    ];
    for (const [status, code, kind] of cases) {
      __resetSessionForTests();
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: code }));
      const err = await signIn({ interactive: false }, { entra: entra(), fetchImpl }).catch(
        (e: unknown) => e,
      );
      expect(err, code).toBeInstanceOf(AuthBlockedError);
      expect((err as AuthBlockedError).kind, code).toBe(kind);
      expect((err as AuthBlockedError).errorCode, code).toBe(code);
    }
  });

  it('on 401 invalid_token clears state and retries once with a fresh Entra token', async () => {
    const entraDeps = entra();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const session = await signIn({ interactive: false }, { entra: entraDeps, fetchImpl });
    expect(session.user.id).toBe('u-1');
    expect(entraDeps.getSsoToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates InvalidEntraTokenError when the retry also 401s', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'invalid_token' }));
    await expect(
      signIn({ interactive: false }, { entra: entra(), fetchImpl }),
    ).rejects.toBeInstanceOf(InvalidEntraTokenError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('reExchange', () => {
  it('is single-flight: concurrent callers share one exchange', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const p1 = reExchange({ entra: entra(), fetchImpl });
    const p2 = reExchange({ entra: entra(), fetchImpl });
    // signIn awaits the async Entra token before calling fetchImpl, so the
    // deferred resolver is only assigned after the pending microtasks flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFetch(jsonResponse(200, OK_BODY));
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1.sessionToken).toBe(s2.sessionToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('session store', () => {
  it('restores from sessionStorage and rejects expired entries', () => {
    sessionStorage.setItem(
      'breeze-client-ai-session',
      JSON.stringify({
        sessionToken: 'tok',
        expiresAt: Date.now() + 60_000,
        user: OK_BODY.user,
        org: null,
        branding: null,
      }),
    );
    expect(getStoredSession()?.sessionToken).toBe('tok');
    __resetSessionForTests();
    sessionStorage.setItem(
      'breeze-client-ai-session',
      JSON.stringify({
        sessionToken: 'tok',
        expiresAt: Date.now() - 1,
        user: OK_BODY.user,
        org: null,
        branding: null,
      }),
    );
    expect(getStoredSession()).toBeNull();
  });

  it('clearSession wipes memory and sessionStorage', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    await signIn({ interactive: false }, { entra: entra(), fetchImpl });
    clearSession();
    expect(getSessionToken()).toBeNull();
    expect(sessionStorage.getItem('breeze-client-ai-session')).toBeNull();
  });
});
