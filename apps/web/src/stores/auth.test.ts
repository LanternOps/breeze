import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tokens, User } from './auth';
import { applyResolvedLocalePreferences } from '@/lib/appearance';
import {
  apiAcceptInvite,
  apiLogin,
  apiLogout,
  apiPreviewInvite,
  apiResetPassword,
  apiVerifyMFA,
  AuthSessionExpiredError,
  fetchAndApplyPreferences,
  fetchWithAuth,
  resolveApiOrigin,
  restoreAccessTokenFromCookie,
  useAuthStore,
  waitForPendingRefresh
} from './auth';

// fetchAndApplyPreferences (auth.ts) is the only call site for these two exports
// (verified via grep on auth.ts) — mocking the whole appearance module is safe
// for the rest of this file. This isolates the auth.ts -> appearance.ts seam so
// a rename on either side (e.g. data.partnerDefaultLocale) fails a test instead
// of silently passing.
vi.mock('@/lib/appearance', () => ({
  applyAppearancePreferences: vi.fn(),
  applyResolvedLocalePreferences: vi.fn()
}));

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const baseUser: User = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'User One',
  mfaEnabled: false
};

const baseTokens: Tokens = {
  accessToken: 'access-old',
  expiresInSeconds: 3600
};

describe('auth store fetchWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
    document.cookie = 'breeze_csrf_token=csrf-test-token; path=/';
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null
    });
  });

  it('adds auth and json headers to authenticated requests', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/devices', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/devices');

    const headers = options.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${baseTokens.accessToken}`);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('does not force a JSON content-type on FormData bodies (avatar upload)', async () => {
    // Forcing application/json on a multipart body strips the boundary the
    // browser would otherwise add, so the server cannot parse the upload and
    // 400s. The avatar POST must leave Content-Type unset for FormData.
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    await fetchWithAuth('/users/me/avatar', { method: 'POST', body: form });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${baseTokens.accessToken}`);
    expect(headers.get('Content-Type')).toBeNull();
  });

  it('aborts a JSON request at the 30s default timeout', async () => {
    vi.useFakeTimers();
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      let captured: AbortSignal | undefined;
      const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        captured = opts.signal as AbortSignal;
        return new Promise<Response>(() => {}); // never resolves so the timeout stays pending
      });
      vi.stubGlobal('fetch', fetchMock);

      void fetchWithAuth('/devices', { method: 'GET' });
      await Promise.resolve();
      expect(captured?.aborted).toBe(false);

      vi.advanceTimersByTime(30_000);
      expect(captured?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives FormData uploads a 10-minute ceiling, not the 30s default (issue #1601)', async () => {
    // A large installer (hundreds of MB) takes far longer than 30s to send. The
    // old blanket 30s timeout aborted the in-flight upload — surfacing "signal is
    // aborted without reason" — even though the server received the file. Uploads
    // must survive well past 30s.
    vi.useFakeTimers();
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      let captured: AbortSignal | undefined;
      const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        captured = opts.signal as AbortSignal;
        return new Promise<Response>(() => {});
      });
      vi.stubGlobal('fetch', fetchMock);

      const form = new FormData();
      form.append('file', new Blob(['x'], { type: 'application/octet-stream' }), 'big.msi');
      void fetchWithAuth('/software/catalog/c1/versions/upload', { method: 'POST', body: form });
      await Promise.resolve();
      expect(captured?.aborted).toBe(false);

      vi.advanceTimersByTime(30_000);
      expect(captured?.aborted).toBe(false); // still alive past the JSON cap

      vi.advanceTimersByTime(10 * 60_000);
      expect(captured?.aborted).toBe(true); // aborts only at the upload ceiling
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips only exact /api prefix while preserving /api-* routes', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: true }))
      .mockResolvedValueOnce(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/api/devices');
    await fetchWithAuth('/api-keys', { method: 'POST', body: JSON.stringify({ name: 'ci' }) });

    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toBe('/api/v1/devices');
    expect(secondUrl).toBe('/api/v1/api-keys');
  });

  it('does not double the /v1 for server-stored /api/v1/ paths (e.g. avatar_url)', async () => {
    // users.avatar_url is stored as /api/v1/users/:id/avatar and round-trips
    // through fetchWithAuth (the avatar blob fetch). Without the /api/v1/
    // branch in buildApiUrl it became /api/v1/v1/users/:id/avatar → 404 and a
    // broken avatar.
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/api/v1/users/user-9/avatar');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/v1/users/user-9/avatar');
    expect(url).not.toContain('/v1/v1/');
  });

  it('refreshes and retries when access token is expired', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const refreshedTokens: Tokens = {
      accessToken: 'access-new',
      expiresInSeconds: 3600
    };

    const firstUnauthorized = makeResponse({ error: 'unauthorized' }, false, 401);
    const refreshSuccess = makeResponse({ tokens: refreshedTokens }, true, 200);
    const retrySuccess = makeResponse({ data: { id: 'dev-1' } }, true, 200);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(firstUnauthorized)
      .mockResolvedValueOnce(refreshSuccess)
      .mockResolvedValueOnce(retrySuccess);
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/devices/dev-1');

    expect(response).toBe(retrySuccess);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const refreshCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(refreshCall[0]).toBe('/api/v1/auth/refresh');
    expect(refreshCall[1].method).toBe('POST');
    expect(refreshCall[1].body).toBe(JSON.stringify({}));
    expect(new Headers(refreshCall[1].headers).get('x-breeze-csrf')).toBe('csrf-test-token');

    const retryCall = fetchMock.mock.calls[2] as [string, RequestInit];
    const retryHeaders = retryCall[1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe(`Bearer ${refreshedTokens.accessToken}`);
    expect(useAuthStore.getState().tokens?.accessToken).toBe(refreshedTokens.accessToken);
  });

  it('restores token before request when authenticated but token is missing', async () => {
    useAuthStore.setState({
      user: baseUser,
      tokens: null,
      isAuthenticated: true,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null
    });

    const refreshedTokens: Tokens = {
      accessToken: 'access-restored',
      expiresInSeconds: 3600
    };

    const refreshSuccess = makeResponse({ tokens: refreshedTokens }, true, 200);
    const apiSuccess = makeResponse({ data: { ok: true } }, true, 200);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(refreshSuccess)
      .mockResolvedValueOnce(apiSuccess);
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/devices');

    expect(response).toBe(apiSuccess);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/auth/refresh',
      expect.objectContaining({ method: 'POST' })
    );

    const secondCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(secondCall[0]).toBe('/api/v1/devices');
    expect(new Headers(secondCall[1].headers).get('Authorization')).toBe(`Bearer ${refreshedTokens.accessToken}`);
    expect(useAuthStore.getState().tokens?.accessToken).toBe(refreshedTokens.accessToken);
  });

  it('skipUnauthorizedRetry: never replays a single-use body after a 401', async () => {
    // The approvals decide POST carries a WebAuthn assertion the server
    // consumes and can reject with 401 (`assertion_failed`). Refreshing the
    // (still valid) session and replaying re-sends an already-burned assertion.
    useAuthStore.getState().login(baseUser, baseTokens);
    const unauthorized = makeResponse({ error: 'assertion_failed' }, false, 401);
    const fetchMock = vi.fn().mockResolvedValueOnce(unauthorized);
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/mobile/approvals/ap-1/approve', {
      method: 'POST',
      body: JSON.stringify({ proof: { type: 'webauthn_platform' } }),
      skipUnauthorizedRetry: true,
    });

    expect(response).toBe(unauthorized);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh, no replay
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('logs out when token refresh fails', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401))
      .mockResolvedValueOnce(makeResponse({ error: 'refresh denied' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/devices');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  // QA 2026-07-08: a single transient 502 on /auth/refresh must NOT boot the
  // user — a gateway blip reaches no verdict on the refresh cookie, so we retry
  // with backoff and recover the session instead of hard-logging-out.
  it('retries a transient 5xx on refresh and keeps the session', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const refreshedTokens: Tokens = { accessToken: 'access-after-502', expiresInSeconds: 3600 };
    const apiSuccess = makeResponse({ data: { ok: true } }, true, 200);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401)) // original request
      .mockResolvedValueOnce(makeResponse({ error: 'bad gateway' }, false, 502))  // refresh blips
      .mockResolvedValueOnce(makeResponse({ tokens: refreshedTokens }, true, 200)) // refresh recovers
      .mockResolvedValueOnce(apiSuccess);                                          // original replayed
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/devices');

    expect(response).toBe(apiSuccess);
    // Session survived the blip and adopted the recovered token.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().tokens?.accessToken).toBe(refreshedTokens.accessToken);
    // Two refresh attempts fired (502 then success).
    const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/refresh'));
    expect(refreshCalls).toHaveLength(2);
  });

  // The retry is bounded: a sustained gateway outage still evicts once the
  // backoff attempts are exhausted (no infinite hang).
  it('logs out when refresh 5xx persists past the retry budget', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401)) // original request
      .mockResolvedValue(makeResponse({ error: 'bad gateway' }, false, 502));      // every refresh 502s
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/devices');

    // Initial attempt + MAX_TRANSIENT_REFRESH_RETRIES (2) = 3 refresh calls, then evict.
    const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/refresh'));
    expect(refreshCalls).toHaveLength(3);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  // Regression (0.83.1 forced-MFA enrollment hotfix): when the store is
  // authenticated but holds no in-memory access token (always true on the
  // forced-MFA page after a full-page nav) and the cookie-backed refresh
  // FAILS, fetchWithAuth must NOT fire the request with no Authorization
  // header (the old behavior produced a confusing API 401 "Missing or invalid
  // authorization header" that stranded the user). It must instead clear the
  // dead session, redirect to /login, and throw AuthSessionExpiredError.
  it('does not send a headerless request when authenticated but refresh fails; bounces to login', async () => {
    useAuthStore.setState({
      user: baseUser,
      tokens: null,
      isAuthenticated: true,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null
    });

    // Only the /auth/refresh recovery attempt should ever be fetched; it 401s.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ error: 'unauthorized' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    const hrefSetter = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/auth/mfa/setup',
        search: '?forced=1',
        get href() {
          return '';
        },
        set href(value: string) {
          hrefSetter(value);
        }
      }
    });

    try {
      await expect(fetchWithAuth('/auth/mfa/setup', { method: 'POST' })).rejects.toBeInstanceOf(
        AuthSessionExpiredError
      );
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation
      });
    }

    // The real endpoint (/auth/mfa/setup) was NEVER fetched — only the refresh
    // recovery attempt fired, then we bailed.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/mfa/setup'))
    ).toHaveLength(0);
    // Session cleared and a /login redirect (with returnTo) was issued.
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
    expect(hrefSetter).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent('/auth/mfa/setup?forced=1')}`
    );
  });

  it('deduplicates concurrent refresh requests', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const refreshedTokens: Tokens = {
      accessToken: 'access-new',
      expiresInSeconds: 3600
    };

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/api/v1/auth/refresh')) {
        return makeResponse({ tokens: refreshedTokens }, true, 200);
      }

      const authHeader = new Headers(init?.headers).get('Authorization');
      if (authHeader === `Bearer ${refreshedTokens.accessToken}`) {
        return makeResponse({ ok: true }, true, 200);
      }

      return makeResponse({ error: 'unauthorized' }, false, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      fetchWithAuth('/devices'),
      fetchWithAuth('/alerts')
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(useAuthStore.getState().tokens?.accessToken).toBe(refreshedTokens.accessToken);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/refresh'))).toHaveLength(1);
  });
});

describe('auth API helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
    document.cookie = 'breeze_csrf_token=csrf-test-token; path=/';
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null
    });
  });

  it('apiLogin returns MFA challenge payload when required', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        mfaRequired: true,
        tempToken: 'temp-1',
        mfaMethod: 'sms',
        phoneLast4: '1234'
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiLogin('user@example.com', 'password');

    expect(result).toEqual({
      success: true,
      mfaRequired: true,
      tempToken: 'temp-1',
      mfaMethod: 'sms',
      // #2153: response now always reports whether a passkey alternate exists;
      // a login body without the flag normalizes to false.
      passkeyAvailable: false,
      phoneLast4: '1234'
    });
  });

  it('apiLogin surfaces passkeyAvailable when the account has an alternate passkey', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        mfaRequired: true,
        tempToken: 'temp-2',
        mfaMethod: 'totp',
        passkeyAvailable: true
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiLogin('user@example.com', 'password');

    expect(result).toMatchObject({
      success: true,
      mfaRequired: true,
      mfaMethod: 'totp',
      passkeyAvailable: true
    });
  });

  it('apiVerifyMFA returns user/tokens on success', async () => {
    const tokens: Tokens = {
      accessToken: 'access-new',
      expiresInSeconds: 3600
    };
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        user: baseUser,
        tokens
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiVerifyMFA('123456', 'temp-1', 'totp');

    expect(result).toEqual({ success: true, user: { ...baseUser, requiresSetup: false }, tokens, requiresSetup: false });
  });

  it('apiLogout clears state even when logout network call fails', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await apiLogout();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('apiPreviewInvite sends the token in a POST body, not in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ email: 'invitee@example.com', orgName: 'Acme' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiPreviewInvite('raw-invite-token');

    expect(result.success).toBe(true);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/invite/preview');
    expect(url).not.toContain('raw-invite-token');
    expect(options.method).toBe('POST');
    expect(options.referrerPolicy).toBe('no-referrer');
    expect(options.body).toBe(JSON.stringify({ token: 'raw-invite-token' }));
  });

  it('token-bearing reset and invite requests suppress referrers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: true }))
      .mockResolvedValueOnce(makeResponse({ user: baseUser, tokens: baseTokens }));
    vi.stubGlobal('fetch', fetchMock);

    await apiResetPassword('reset-token', 'strong-password');
    await apiAcceptInvite('invite-token', 'strong-password');

    expect((fetchMock.mock.calls[0][1] as RequestInit).referrerPolicy).toBe('no-referrer');
    expect((fetchMock.mock.calls[1][1] as RequestInit).referrerPolicy).toBe('no-referrer');
  });
});

describe('refresh rotation-race recovery (#1107)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
    document.cookie = 'breeze_csrf_token=csrf-test-token; path=/';
    useAuthStore.setState({
      user: baseUser,
      tokens: null,
      isAuthenticated: true,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null
    });
  });

  const racedResponse = (): Response =>
    ({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: 'Refresh already in progress', reason: 'refresh_raced' })
    }) as unknown as Response;

  it('retries refresh once when the server reports a benign race, then succeeds', async () => {
    const refreshed: Tokens = { accessToken: 'access-after-race', expiresInSeconds: 3600 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(racedResponse())
      .mockResolvedValueOnce(makeResponse({ tokens: refreshed }, true, 200));
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreAccessTokenFromCookie();

    expect(restored).toBe(true);
    // First attempt raced; the second (retry) won — exactly one retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/api/v1/auth/refresh'))).toBe(true);
    expect(useAuthStore.getState().tokens?.accessToken).toBe('access-after-race');
  });

  it('gives up after a single retry if the race persists (no infinite loop)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(racedResponse())
      .mockResolvedValueOnce(racedResponse());
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreAccessTokenFromCookie();

    expect(restored).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a non-raced 401 (genuine auth failure)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'Invalid refresh token' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreAccessTokenFromCookie();

    expect(restored).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes refresh through the Web Locks API when available, under the right lock name (#1107)', async () => {
    // jsdom has no navigator.locks, so the rest of the suite exercises the
    // fallback. Stub it here to prove the cross-tab serialization wiring:
    // correct lock name, fn run inside the lock, result propagated.
    const requestMock = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    const prevLocks = (navigator as unknown as { locks?: unknown }).locks;
    Object.defineProperty(navigator, 'locks', { value: { request: requestMock }, configurable: true });

    try {
      const refreshed: Tokens = { accessToken: 'access-locked', expiresInSeconds: 3600 };
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ tokens: refreshed }, true, 200));
      vi.stubGlobal('fetch', fetchMock);

      const restored = await restoreAccessTokenFromCookie();

      expect(restored).toBe(true);
      expect(requestMock).toHaveBeenCalledWith('breeze-token-refresh', expect.any(Function));
      expect(useAuthStore.getState().tokens?.accessToken).toBe('access-locked');
    } finally {
      if (prevLocks === undefined) {
        delete (navigator as unknown as { locks?: unknown }).locks;
      } else {
        Object.defineProperty(navigator, 'locks', { value: prevLocks, configurable: true });
      }
    }
  });
});

describe('waitForPendingRefresh (#950)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves immediately when no refresh is in flight', async () => {
    const before = Date.now();
    await waitForPendingRefresh();
    expect(Date.now() - before).toBeLessThan(50);
  });

  it('serializes behind an in-flight refresh', async () => {
    // Block the underlying /auth/refresh call so the in-flight promise stays
    // pending; resolve it later and assert waitForPendingRefresh resolves
    // only AFTER the in-flight one settles. This is the core anti-race
    // semantic — without it, the post-reload page beats the pre-reload page
    // to its own cookie consumption.
    let resolveRefresh!: (value: unknown) => void;
    const refreshGate = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await refreshGate;
      return makeResponse({ user: baseUser, tokens: baseTokens });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Kick off a refresh (don't await). restoreAccessTokenFromCookie uses
    // the same shared in-flight gate that waitForPendingRefresh observes.
    const inflight = restoreAccessTokenFromCookie();

    // Microtask yield so the underlying requestTokenRefresh call has been
    // dispatched and the module's tokenRefreshInFlight is populated.
    await Promise.resolve();

    let waitResolved = false;
    const waitPromise = waitForPendingRefresh().then(() => {
      waitResolved = true;
    });

    // Confirm we have NOT resolved yet — refresh is still pending.
    await Promise.resolve();
    expect(waitResolved).toBe(false);

    // Unblock the refresh; waitForPendingRefresh should now resolve.
    resolveRefresh(undefined);
    await inflight;
    await waitPromise;
    expect(waitResolved).toBe(true);
  });

  it('does not propagate refresh failures', async () => {
    // The whole point is serialization-without-coupling; if the pre-reload
    // refresh threw, the caller (OrgSwitcher) still needs to proceed to its
    // reload step so the post-reload page gets its own clean attempt.
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const inflight = restoreAccessTokenFromCookie();
    await Promise.resolve();

    await expect(waitForPendingRefresh()).resolves.toBeUndefined();
    await inflight;
  });
});

describe('resolveApiOrigin', () => {
  // PUBLIC_API_URL is blank in the test/CI env (and in production behind Caddy),
  // so this exercises exactly the production fallback path that makes the
  // Huntress webhook URL region-correct (#1737): fall back to the page origin.
  it('falls back to the current page origin when PUBLIC_API_URL is blank', () => {
    const origin = resolveApiOrigin();
    expect(origin).toBe(window.location.origin);
    // Must be an absolute origin (scheme + host) with no path, so callers can
    // safely append /api/v1/... without producing a scheme-less or doubled URL.
    expect(origin).toMatch(/^https?:\/\/[^/]+$/);
  });
});

describe('fetchAndApplyPreferences locale wiring', () => {
  const applyResolvedLocalePreferencesMock = vi.mocked(applyResolvedLocalePreferences);

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
    document.cookie = 'breeze_csrf_token=csrf-test-token; path=/';
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null
    });
    useAuthStore.getState().login(baseUser, baseTokens);
  });

  // Payload shape mirrors GET /users/me in apps/api/src/routes/users.ts:
  // preferences.locale is the user's own choice, partnerDefaultLocale is a
  // top-level sibling field (not nested under preferences).
  it('calls applyResolvedLocalePreferences with the user locale and partner default when both are set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        id: 'user-1',
        email: 'user@example.com',
        name: 'User One',
        preferences: { theme: 'dark', locale: 'pt-BR' },
        partnerId: 'partner-1',
        orgId: null,
        scope: 'partner',
        partnerDefaultLocale: 'pt-BR',
        permissions: [],
        requiresSetup: false
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchAndApplyPreferences();

    expect(applyResolvedLocalePreferencesMock).toHaveBeenCalledTimes(1);
    expect(applyResolvedLocalePreferencesMock).toHaveBeenCalledWith('pt-BR', 'pt-BR');
  });

  it('calls applyResolvedLocalePreferences with an absent user locale and the partner default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        id: 'user-1',
        email: 'user@example.com',
        name: 'User One',
        // No locale field: the user hasn't chosen one yet.
        preferences: { theme: 'dark' },
        partnerId: 'partner-1',
        orgId: null,
        scope: 'partner',
        partnerDefaultLocale: 'pt-BR',
        permissions: [],
        requiresSetup: false
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchAndApplyPreferences();

    expect(applyResolvedLocalePreferencesMock).toHaveBeenCalledTimes(1);
    expect(applyResolvedLocalePreferencesMock).toHaveBeenCalledWith(undefined, 'pt-BR');
  });

  it('does not call applyResolvedLocalePreferences and logs a warning when the response is not ok', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: 'server error' }, false, 500));
    vi.stubGlobal('fetch', fetchMock);

    await fetchAndApplyPreferences();

    expect(applyResolvedLocalePreferencesMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain('locale resolution skipped');
  });

  it('does not throw and logs a warning when the fetch itself throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAndApplyPreferences()).resolves.toBeUndefined();

    expect(applyResolvedLocalePreferencesMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain('locale resolution skipped');
  });
});
