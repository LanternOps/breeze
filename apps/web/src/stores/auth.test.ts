import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tokens, User } from './auth';
import { applyResolvedLocalePreferences } from '@/lib/appearance';
import {
  apiAcceptInvite,
  apiEnableSmsMfa,
  apiEnableTotpMfa,
  apiEnrollPasskey,
  apiGetMfaEnrollmentOptions,
  apiLogin,
  apiLogout,
  apiPrepareCfTerminalLogout,
  apiPreviewInvite,
  apiRegisterPartner,
  apiResetPassword,
  apiVerifyEmail,
  apiVerifyMFA,
  apiVerifyPasskeyMFA,
  AuthSessionExpiredError,
  AuthThrottledError,
  fetchAndApplyPreferences,
  fetchWithAuth,
  handleSessionExpired,
  resolveApiOrigin,
  restoreAccessTokenFromCookie,
  restoreAccessTokenFromCookieDetailed,
  setThrottleMaskMounted,
  useAuthStore,
  waitForPendingRefresh,
  validateCfTerminalNavigationUrl,
} from './auth';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'credential-1', response: {} })),
  startRegistration: vi.fn(async () => ({ id: 'credential-1', response: {} })),
}));

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

// Like makeResponse, but with a real Headers bag. Needed for the #3696
// throttle tests: the client reads `Retry-After` off a 429 to decide how long
// to wait, and the header-less double above exercises only the fallback path.
const makeResponseWithHeaders = (
  payload: unknown,
  ok: boolean,
  status: number,
  headers: Record<string, string> = {}
): Response =>
  ({
    ok,
    status,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const refreshCallsOf = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/refresh'));

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

// jsdom doesn't allow assigning window.location directly, so swap in a
// minimal stub for the pieces handleSessionExpired/loginPathWithNext read
// (pathname/search/hash) and a spy for replace(), then restore the original.
function mockLocation(pathname: string, search = '') {
  const originalLocation = window.location;
  const replace = vi.fn();
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname, search, hash: '', replace, reload }
  });
  return {
    replace,
    reload,
    restore: () => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  };
}

describe('auth store fetchWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
    document.cookie = 'breeze_csrf_token=csrf-test-token; path=/';
    // login() resets the module-level handleSessionExpired in-flight flag —
    // call it first so a prior test's expiry redirect doesn't suppress this
    // test's (the flag is a module singleton, not reset between tests).
    useAuthStore.getState().login(baseUser, baseTokens);
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null,
      sessionExpiredReason: null
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

  it('logs out, sets sessionExpiredReason, and redirects when token refresh fails (Path B)', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401))
      .mockResolvedValueOnce(makeResponse({ error: 'refresh denied' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    const { replace, restore } = mockLocation('/devices');
    let response: Response;
    try {
      response = await fetchWithAuth('/devices');
    } finally {
      restore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    // handleSessionExpired: reason is set before logout() collapses the nav,
    // and the stale 401 is still returned — the caller may inspect it, and
    // the page is navigating away regardless.
    expect(useAuthStore.getState().sessionExpiredReason).toBe('session-expired');
    expect(response!.status).toBe(401);
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/devices')}&reason=session-expired`);
  });

  // Self-hosted origin rejection, NOT a dead session. A self-hoster who reaches
  // the dashboard over an SSH tunnel (`ssh -L 8443:127.0.0.1:443`) browses
  // https://localhost:8443 while the generated .env allows only
  // https://localhost, so validateCookieCsrfRequest answers POST /auth/refresh
  // with 403 {"error":"Invalid request origin"}. Evicting is still correct —
  // no access token can be minted from that origin — but reporting it as
  // "session expired" made a pure config problem read as a wrong password,
  // after EVERY successful login. The reason code is what lets the login page
  // name the origin and the two settings that fix it.
  it('reports a 403 "Invalid request origin" refresh as origin-rejected, not session-expired', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401))
      .mockResolvedValueOnce(makeResponse({ error: 'Invalid request origin' }, false, 403));
    vi.stubGlobal('fetch', fetchMock);

    const { replace, restore } = mockLocation('/devices');
    try {
      await fetchWithAuth('/devices');
    } finally {
      restore();
    }

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().sessionExpiredReason).toBe('origin-rejected');
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/devices')}&reason=origin-rejected`);
  });

  // The discriminator is the body, not the status: every OTHER 403 on refresh
  // stays a generic expiry, or the notice would blame CORS for unrelated
  // rejections.
  it('leaves an unrelated 403 on refresh as a generic session expiry', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401))
      .mockResolvedValueOnce(makeResponse({ error: 'Forbidden' }, false, 403));
    vi.stubGlobal('fetch', fetchMock);

    const { replace, restore } = mockLocation('/devices');
    try {
      await fetchWithAuth('/devices');
    } finally {
      restore();
    }

    expect(useAuthStore.getState().sessionExpiredReason).toBe('session-expired');
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/devices')}&reason=session-expired`);
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

  // Issue #3041: a 429 on /auth/refresh is the rate limiter rejecting the
  // request before it was ever evaluated — no verdict was reached on the
  // refresh cookie, so the session is still valid. It used to fall through to
  // the hard-failure branch, which is how a runaway remote-desktop viewer poll
  // could exhaust the shared per-IP budget and dump an operator with a
  // perfectly valid session on the login screen.
  //
  // Issue #3696 sharpened the handling: a 429 is no longer folded into the
  // generic 'transient' bucket. The transient backoff ladder spends its whole
  // budget in ~0.9s — always INSIDE the server's 60s window — so every retry
  // was a guaranteed 429 that additionally consumed a slot in the server's
  // sliding window and dug the client deeper. A 429 now returns immediately
  // and the caller waits out the server-supplied `Retry-After` once.
  it('waits out a 429 on refresh rather than retrying into it, and keeps the session', async () => {
    vi.useFakeTimers();
    // Pin jitter (#3984) to 0 so the wait is exactly the advertised 1_000ms —
    // jitter bounds get their own dedicated test below.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      const refreshedTokens: Tokens = { accessToken: 'access-after-429', expiresInSeconds: 3600 };
      const apiSuccess = makeResponse({ data: { ok: true } }, true, 200);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401))  // original request
        .mockResolvedValueOnce(                                                      // refresh throttled
          makeResponseWithHeaders({ error: 'Too many refresh attempts.', retryAfter: 1 }, false, 429, {
            'Retry-After': '1'
          })
        )
        .mockResolvedValueOnce(makeResponse({ tokens: refreshedTokens }, true, 200)) // refresh recovers
        .mockResolvedValueOnce(apiSuccess);                                          // original replayed
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchWithAuth('/devices');

      // Settle the 401 + the throttled refresh WITHOUT advancing the clock. The
      // regression this guards: the old code fired two more refreshes inside
      // ~0.9s, burning budget it could never win back.
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshCallsOf(fetchMock)).toHaveLength(1);
      // The wait is user-visible, not silent — AuthOverlay masks on this.
      expect(useAuthStore.getState().authThrottledUntil).not.toBeNull();

      await vi.advanceTimersByTimeAsync(1_000);
      const response = await pending;

      expect(response).toBe(apiSuccess);
      // The session must survive being rate limited.
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().tokens?.accessToken).toBe(refreshedTokens.accessToken);
      expect(useAuthStore.getState().sessionExpiredReason).toBeNull();
      // Mask cleared once the session recovered.
      expect(useAuthStore.getState().authThrottledUntil).toBeNull();
      expect(refreshCallsOf(fetchMock)).toHaveLength(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // #3984: jitter must never push the wait past the documented
  // MAX_REFRESH_RETRY_AFTER_MS ceiling (90s) — that ceiling exists precisely
  // to bound a hostile/misconfigured Retry-After, and jittering AFTER a
  // clamp-to-90s would both violate the ceiling and collapse every
  // over-ceiling value onto the exact same un-jittered 90s deadline, which
  // would recreate the lockstep problem this whole fix removes.
  it('never lets jitter push the wait past the 90s ceiling, even for a huge Retry-After', async () => {
    vi.useFakeTimers();
    const randomSpyMax = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 3600 }, false, 429, { 'Retry-After': '3600' })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(0);
      const waitMs = useAuthStore.getState().authThrottledUntil! - Date.now();

      expect(waitMs).toBeLessThanOrEqual(90_000);
      // Still meaningfully jittered even at the ceiling, not collapsed to a
      // single fixed deadline every over-ceiling client would share.
      expect(waitMs).toBeGreaterThan(72_000);

      await vi.advanceTimersByTimeAsync(waitMs);
      await pending;
    } finally {
      randomSpyMax.mockRestore();
      vi.useRealTimers();
    }
  });

  // #3984: a throttled fleet reading the same Retry-After would otherwise all
  // retry at the exact same instant, turning their own recovery into a second
  // synchronized burst. Jitter must only ever ADD time (retrying before the
  // server's granted window just earns another 429) and must stay bounded
  // (never balloon the wait unrecognizably).
  it('jitters the throttle wait, always at or above the advertised window and bounded above it', async () => {
    vi.useFakeTimers();
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 10 }, false, 429, { 'Retry-After': '10' })
      );
      vi.stubGlobal('fetch', fetchMock);

      // random() = 0 -> no jitter added: wait is exactly the advertised 10s.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const pending = restoreAccessTokenFromCookieDetailed();
        await vi.advanceTimersByTimeAsync(0);
        const untilNoJitter = useAuthStore.getState().authThrottledUntil!;
        expect(untilNoJitter - Date.now()).toBe(10_000);
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;
      } finally {
        randomSpy.mockRestore();
      }

      useAuthStore.setState({ authThrottledUntil: null, tokens: null });

      // random() just under 1 -> maximum jitter: up to 25% extra, never more.
      const randomSpyMax = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
      try {
        const pending = restoreAccessTokenFromCookieDetailed();
        await vi.advanceTimersByTimeAsync(0);
        const untilMaxJitter = useAuthStore.getState().authThrottledUntil!;
        const waitMs = untilMaxJitter - Date.now();
        expect(waitMs).toBeGreaterThanOrEqual(10_000);
        expect(waitMs).toBeLessThan(10_000 * 1.25);
        await vi.advanceTimersByTimeAsync(waitMs);
        await pending;
      } finally {
        randomSpyMax.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // #3984: before this fix, AuthThrottledMask (AuthOverlay.tsx) independently
  // counted down to its OWN `window.location.reload()` using the same
  // `authThrottledUntil` deadline this module publishes — so once the bounded
  // in-memory wait was exhausted, TWO timers raced to "recover" the same
  // throttle. Now only the store schedules the reload; it must fire exactly
  // once, only after the bounded wait is exhausted, and never while the
  // access token is still valid.
  it('schedules exactly one automatic reload once the bounded wait is exhausted', async () => {
    vi.useFakeTimers();
    const { reload, restore } = mockLocation('/devices');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter, deterministic
    // The reload only fires while a mask is actually on screen to explain it
    // — see the mask-mounted gate test below. Simulate AuthOverlay's mask
    // being mounted, as it would be on any page that renders it.
    setThrottleMaskMounted(true);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = restoreAccessTokenFromCookieDetailed();

      // The bounded in-memory wait (MAX_THROTTLE_WAITS=1): one wait, one
      // retry, still throttled. This is the store's OWN retry — no reload
      // yet, because the wait isn't exhausted until this resolves.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toBe('throttled');
      expect(reload).not.toHaveBeenCalled();

      // Now exhausted: the store schedules exactly one reload for the next
      // advertised window.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      setThrottleMaskMounted(false);
      randomSpy.mockRestore();
      restore();
      vi.useRealTimers();
    }
  });

  // #3984: a page that handles AuthThrottledError WITHOUT ever mounting
  // AuthOverlay (ForcedMfaSetupPage on AuthLayout is the real example) must
  // never have its in-progress work discarded by a reload it never opted
  // into — the store's reload is conditional on a mask actually being on
  // screen to explain it.
  it('never reloads automatically when no AuthThrottledMask is mounted', async () => {
    vi.useFakeTimers();
    const { reload, restore } = mockLocation('/auth/mfa/setup');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    // Deliberately NOT calling setThrottleMaskMounted(true) — the default
    // (unmounted) state every page starts in until AuthOverlay's mask mounts.
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(1_000); // bounded wait, still throttled
      expect(await pending).toBe('throttled');

      await vi.advanceTimersByTimeAsync(1_000); // the deadline the mask-mounted case reloads at
      expect(reload).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
      restore();
      vi.useRealTimers();
    }
  });

  // #3984: a newer refresh cycle (e.g. AdminSessionManager's keepalive, or
  // another fetchWithAuth call) can start its OWN bounded in-memory wait
  // after the first cycle's reload was already scheduled. The stale timer
  // must defer to whichever cycle is actually in flight rather than
  // reloading mid-way through its retry — otherwise the exact race this PR
  // removed (the mask's reload preempting the store's own retry) just moves
  // to "the store's own stale timer preempts the store's own newer retry".
  it('defers the scheduled reload while a newer refresh cycle is in flight', async () => {
    vi.useFakeTimers();
    const { reload, restore } = mockLocation('/devices');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    setThrottleMaskMounted(true);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      // First cycle: bounded wait exhausted, reload scheduled for t=2000ms.
      const firstPending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await firstPending).toBe('throttled');

      // A second, independent cycle starts (simulating a concurrent caller)
      // just before the first cycle's scheduled reload would fire, and is
      // still in its OWN bounded wait when that stale timer elapses.
      await vi.advanceTimersByTimeAsync(900);
      const secondPending = restoreAccessTokenFromCookieDetailed();

      // t=2000ms: the FIRST cycle's stale reload timer fires here, but the
      // second cycle is now in flight (started at t=1900, sleeping until
      // t=2900) — it must be deferred, not fired.
      await vi.advanceTimersByTimeAsync(100);
      expect(reload).not.toHaveBeenCalled();

      // Let the second cycle finish its own bounded wait and exhaust.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await secondPending).toBe('throttled');

      // The second cycle scheduled its own reload on exhaustion; that one
      // fires normally.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      setThrottleMaskMounted(false);
      randomSpy.mockRestore();
      restore();
      vi.useRealTimers();
    }
  });

  // The scheduled reload re-checks whether the throttle is still actually
  // blocking the page at fire time — a keepalive refresh that gets throttled
  // while the access token is still valid must never discard unsaved work.
  it('does not fire the scheduled reload if the session was restored before the deadline', async () => {
    vi.useFakeTimers();
    const { reload, restore } = mockLocation('/devices');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    setThrottleMaskMounted(true);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      await vi.advanceTimersByTimeAsync(0);
      const pending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(1_000); // exhausts the bounded wait, schedules the reload
      await pending;

      // A concurrent path (another tab, another refresh) restores the token
      // before the scheduled reload's deadline elapses.
      useAuthStore.getState().setTokens(baseTokens);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      setThrottleMaskMounted(false);
      randomSpy.mockRestore();
      restore();
      vi.useRealTimers();
    }
  });

  // #3984: a fresh login/logout before the scheduled deadline must cancel it
  // outright — not just leave the "no access token" check to save the day.
  // Reloading a session that was just (re-)authenticated, or navigating away
  // from a session that was just evicted (whose own redirect already owns
  // navigation), would both be wrong for reasons beyond "is there a token".
  it('cancels a pending scheduled reload on login()', async () => {
    vi.useFakeTimers();
    const { reload, restore } = mockLocation('/devices');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    setThrottleMaskMounted(true);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(1_000); // exhausts the bounded wait, schedules the reload
      expect(await pending).toBe('throttled');

      // A fresh login (e.g. the user re-authenticated in another tab and
      // this one picked it up) lands before the scheduled deadline.
      useAuthStore.getState().login(baseUser, { accessToken: 'fresh-login-token', expiresInSeconds: 3600 });

      await vi.advanceTimersByTimeAsync(1_000); // past the original deadline
      expect(reload).not.toHaveBeenCalled();
    } finally {
      setThrottleMaskMounted(false);
      randomSpy.mockRestore();
      restore();
      vi.useRealTimers();
    }
  });

  it('cancels a pending scheduled reload on logout()', async () => {
    vi.useFakeTimers();
    const { reload, replace, restore } = mockLocation('/devices');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    setThrottleMaskMounted(true);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(1_000); // exhausts the bounded wait, schedules the reload
      expect(await pending).toBe('throttled');

      // The user explicitly signs out (the mask's escape hatch, #3696) before
      // the scheduled deadline elapses.
      useAuthStore.getState().logout();

      await vi.advanceTimersByTimeAsync(1_000); // past the original deadline
      expect(reload).not.toHaveBeenCalled();
      // logout() itself doesn't navigate — confirms this is testing
      // cancellation of the SCHEDULED reload, not incidentally passing
      // because some other navigation already fired.
      expect(replace).not.toHaveBeenCalled();
    } finally {
      setThrottleMaskMounted(false);
      randomSpy.mockRestore();
      restore();
      vi.useRealTimers();
    }
  });

  // #3984: pages/remote/** viewers unmount AuthThrottledMask when the user
  // navigates away from the throttled view (e.g. back to /remote). A reload
  // timer armed while the mask WAS mounted must not fire once it no longer
  // is — there's nothing on screen to have explained it, and the user may
  // be looking at something else entirely by the time it would fire.
  it('does not fire the scheduled reload if the mask unmounts before the deadline', async () => {
    vi.useFakeTimers();
    const { reload, restore } = mockLocation('/remote/vnc/tunnel-1');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    setThrottleMaskMounted(true);
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(1_000); // exhausts the bounded wait, schedules the reload
      expect(await pending).toBe('throttled');

      // The user navigates away from the throttled view; AuthOverlay/its mask
      // unmounts before the scheduled reload's deadline elapses.
      setThrottleMaskMounted(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      setThrottleMaskMounted(false);
      randomSpy.mockRestore();
      restore();
      vi.useRealTimers();
    }
  });

  // THE #3696 REGRESSION. Reproduced live before the fix: eleven sidebar
  // navigations in ~24s (the web app is an Astro MPA, so each one spends a
  // refresh) tripped the per-user 10/60s budget and the client hard-redirected
  // to /login?reason=session-expired with ~15 minutes of session left.
  //
  // A throttle is not a verdict on the refresh cookie. Even when it PERSISTS
  // past the bounded wait, the session must survive: no logout(), no redirect,
  // no "session expired" copy.
  it('never logs out on a 429, even one that persists past the bounded wait', async () => {
    vi.useFakeTimers();
    const { replace, restore } = mockLocation('/devices');
    try {
      useAuthStore.getState().login(baseUser, baseTokens);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, false, 401))
        .mockResolvedValue(
          makeResponseWithHeaders({ error: 'Too many refresh attempts.', retryAfter: 1 }, false, 429, {
            'Retry-After': '1'
          })
        );
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchWithAuth('/devices').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      // Surfaced as its own type — deliberately NOT an AuthSessionExpiredError,
      // which dozens of callers swallow on the assumption the page is already
      // navigating to /login (that swallow is the silent-blank-page variant).
      expect(result).toBeInstanceOf(AuthThrottledError);
      expect(result).not.toBeInstanceOf(AuthSessionExpiredError);

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().tokens).not.toBeNull();
      expect(useAuthStore.getState().sessionExpiredReason).toBeNull();
      expect(replace).not.toHaveBeenCalled();
      // Mask stays up so the page can never render as loaded-but-empty.
      expect(useAuthStore.getState().authThrottledUntil).not.toBeNull();
      // Bounded: the initial refresh plus exactly one retry after one wait.
      expect(refreshCallsOf(fetchMock)).toHaveLength(2);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  // The bootstrap path (authenticated in the persisted store, no in-memory
  // access token) is the one EVERY full-page navigation takes, so it is the
  // path #3696 actually fires on. It must not evict on a throttle either.
  it('does not evict on a 429 during the bootstrap refresh', async () => {
    vi.useFakeTimers();
    const { replace, restore } = mockLocation('/integrations');
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ error: 'Too many refresh attempts.', retryAfter: 1 }, false, 429, {
          'Retry-After': '1'
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchWithAuth('/webhooks').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toBeInstanceOf(AuthThrottledError);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(replace).not.toHaveBeenCalled();
      expect(useAuthStore.getState().sessionExpiredReason).toBeNull();
      // No headerless request was fired — only refreshes went out.
      expect(refreshCallsOf(fetchMock)).toHaveLength(fetchMock.mock.calls.length);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  // Guard the other direction: not evicting on a THROTTLE must not stop us
  // evicting on a real verdict. A 429 followed by a hard 401 is a dead session.
  it('still evicts when the refresh reaches a hard 401 after a throttle', async () => {
    vi.useFakeTimers();
    const { replace, restore } = mockLocation('/devices');
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
        )
        .mockResolvedValue(makeResponse({ error: 'Invalid refresh token' }, false, 401));
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchWithAuth('/devices').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toBeInstanceOf(AuthSessionExpiredError);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().sessionExpiredReason).toBe('session-expired');
      expect(replace).toHaveBeenCalled();
      // The mask must not outlive the session it was masking.
      expect(useAuthStore.getState().authThrottledUntil).toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  // The mask must not outlive its cause on ANY exit path. 'restored' and
  // 'auth-failed' are covered above; this covers the third — the retry after
  // the wait comes back 5xx, i.e. still no verdict, but no longer a throttle.
  it('clears the throttle mask when the post-wait retry is a transient failure', async () => {
    vi.useFakeTimers();
    const { restore } = mockLocation('/devices');
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
        )
        .mockResolvedValue(makeResponse({ error: 'bad gateway' }, false, 502));
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchWithAuth('/devices').catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      // A sustained 5xx is still a bounded-retries-then-evict path (unchanged
      // by #3696) — what must NOT happen is the throttle mask being left up.
      expect(result).toBeInstanceOf(AuthSessionExpiredError);
      expect(useAuthStore.getState().authThrottledUntil).toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  // A `Retry-After: 0` (the sliding window's oldest entry about to age out)
  // must never be honoured literally — that is a busy-loop against the very
  // limiter that is rejecting us. Clamped to a floor of one second.
  it('clamps a zero/absent Retry-After to a non-zero wait', async () => {
    vi.useFakeTimers();
    const { restore } = mockLocation('/devices');
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ error: 'Too many refresh attempts.' }, false, 429, {
          'Retry-After': '0'
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = fetchWithAuth('/devices').catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);

      const until = useAuthStore.getState().authThrottledUntil;
      expect(until).not.toBeNull();
      expect(until! - Date.now()).toBeGreaterThan(0);
      // Still exactly one refresh — the clamp did not turn into an immediate retry.
      expect(refreshCallsOf(fetchMock)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(120_000);
      await pending;
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  // The detailed restore helper is what AuthOverlay / AuthGuard branch on, so
  // 'throttled' has to reach them distinctly from 'auth-failed' — collapsing
  // the two is what produced the bare, unexplained soft redirect to /login.
  it('surfaces a 429 as a distinct "throttled" outcome to restore callers', async () => {
    vi.useFakeTimers();
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const fetchMock = vi.fn().mockResolvedValue(
        makeResponseWithHeaders({ retryAfter: 1 }, false, 429, { 'Retry-After': '1' })
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = restoreAccessTokenFromCookieDetailed();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await pending).toBe('throttled');
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

    // Mocked so handleSessionExpired's redirect (fired via the same Path B
    // eviction as the test above) doesn't attempt a real jsdom navigation.
    const { restore } = mockLocation('/devices');
    try {
      await fetchWithAuth('/devices');
    } finally {
      restore();
    }

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

    const { replace, restore } = mockLocation('/auth/mfa/setup', '?forced=1');

    try {
      await expect(fetchWithAuth('/auth/mfa/setup', { method: 'POST' })).rejects.toBeInstanceOf(
        AuthSessionExpiredError
      );
    } finally {
      restore();
    }

    // The real endpoint (/auth/mfa/setup) was NEVER fetched — only the refresh
    // recovery attempt fired, then we bailed.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/mfa/setup'))
    ).toHaveLength(0);
    // Session cleared, sessionExpiredReason set before the collapse, and a
    // /login redirect (via loginPathWithNext + ?reason=) was issued.
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
    expect(useAuthStore.getState().sessionExpiredReason).toBe('session-expired');
    expect(replace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent('/auth/mfa/setup?forced=1')}&reason=session-expired`
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

  it('preserves a caller-provided Content-Type instead of forcing JSON', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/software/catalog/c1/versions/uploads/u1/chunks?offset=0', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'raw-bytes',
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Headers).get('Content-Type')).toBe('application/octet-stream');
  });

  it('rejects a timed-out request with a readable error, not "signal is aborted without reason"', async () => {
    vi.useFakeTimers();
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      // fetch that only settles when its signal aborts, rejecting with the
      // signal's reason — exactly what real fetch does.
      const fetchMock = vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(options.signal?.reason ?? new DOMException('signal is aborted without reason', 'AbortError')),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const pending = fetchWithAuth('/devices');
      const assertion = expect(pending).rejects.toThrow(/timed out after 30s/);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the abort signal through to the 401 retry request', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn()
      // 1st: original request → 401
      .mockResolvedValueOnce(makeResponse({ error: 'expired' }, false, 401))
      // 2nd: /auth/refresh → new tokens
      .mockResolvedValueOnce(
        makeResponse({ success: true, tokens: { accessToken: 'access-new', expiresInSeconds: 900 } }),
      )
      // 3rd: replayed original request → 200
      .mockResolvedValueOnce(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/devices', { method: 'POST', body: JSON.stringify({}) });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryOptions = fetchMock.mock.calls[2][1] as RequestInit;
    expect(retryOptions.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('handleSessionExpired', () => {
  beforeEach(() => {
    // login() resets the module-level in-flight flag — see the comment in
    // the fetchWithAuth describe's beforeEach above.
    useAuthStore.getState().login(baseUser, baseTokens);
    useAuthStore.setState({ sessionExpiredReason: null });
  });

  it('is idempotent: two concurrent expiries redirect exactly once', () => {
    const { replace, restore } = mockLocation('/devices');
    try {
      handleSessionExpired('session-expired');
      handleSessionExpired('session-expired');
    } finally {
      restore();
    }

    expect(replace).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().sessionExpiredReason).toBe('session-expired');
  });

  it('does not attempt a redirect when already on /login', () => {
    const { replace, restore } = mockLocation('/login');
    try {
      handleSessionExpired('idle');
    } finally {
      restore();
    }

    expect(replace).not.toHaveBeenCalled();
    // Session is still evicted and the reason still set — only the redirect
    // is skipped, since the login page has nowhere useful to bounce to.
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().sessionExpiredReason).toBe('idle');
  });

  it('login() resets the in-flight flag and clears sessionExpiredReason', () => {
    const { replace, restore } = mockLocation('/devices');
    try {
      handleSessionExpired('session-expired');
      expect(replace).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().sessionExpiredReason).toBe('session-expired');

      useAuthStore.getState().login(baseUser, baseTokens);
      expect(useAuthStore.getState().sessionExpiredReason).toBeNull();

      // Flag was re-armed by login(); a fresh expiry redirects again instead
      // of being swallowed as a stale in-flight duplicate.
      handleSessionExpired('session-expired');
      expect(replace).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
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

    expect(result).toMatchObject({
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

  it.each([
    {
      name: 'password login',
      invoke: () => apiLogin('user@example.com', 'password'),
      responses: [
        makeResponse({ reason: 'auth_binding_rotation_required' }, false, 428),
        makeResponse({ user: baseUser, tokens: baseTokens }),
      ],
      issuerPath: '/api/v1/auth/login',
    },
    {
      name: 'MFA verification',
      invoke: () => apiVerifyMFA('123456', 'temp-1', 'totp'),
      responses: [
        makeResponse({ reason: 'auth_binding_rotation_required' }, false, 428),
        makeResponse({ user: baseUser, tokens: baseTokens }),
      ],
      issuerPath: '/api/v1/auth/mfa/verify',
    },
    {
      name: 'email verification finalization',
      invoke: () => apiVerifyEmail('verify-token'),
      responses: [
        makeResponse({ reason: 'binding_refresh' }, false, 428),
        makeResponse({ verified: true, user: baseUser, tokens: baseTokens }),
      ],
      issuerPath: '/api/v1/auth/verify-email',
    },
    {
      name: 'invite acceptance',
      invoke: () => apiAcceptInvite('invite-token', 'strong-password'),
      responses: [
        makeResponse({ reason: 'binding_refresh' }, false, 428),
        makeResponse({ user: baseUser, tokens: baseTokens }),
      ],
      issuerPath: '/api/v1/auth/accept-invite',
    },
  ])('retries $name exactly once on 428 and advertises transition-v1', async ({ invoke, responses, issuerPath }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await invoke();

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url).toBe(issuerPath);
      expect(new Headers(init.headers).get('x-breeze-auth-transition')).toBe('v1');
    }
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
  });

  it('retries only passkey verification on 428, not challenge options', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ options: { challenge: 'challenge-1' } }))
      .mockResolvedValueOnce(makeResponse({ reason: 'auth_binding_rotation_required' }, false, 428))
      .mockResolvedValueOnce(makeResponse({ user: baseUser, tokens: baseTokens }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiVerifyPasskeyMFA('temp-1');

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/mfa/passkey/options');
    const verifyCalls = fetchMock.mock.calls.slice(1) as Array<[string, RequestInit]>;
    expect(verifyCalls).toHaveLength(2);
    for (const [url, init] of verifyCalls) {
      expect(url).toContain('/auth/mfa/passkey/verify');
      expect(new Headers(init.headers).get('x-breeze-auth-transition')).toBe('v1');
    }
  });

  it('apiLogout clears state even when logout network call fails', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await apiLogout();

    expect(outcome.kind).toBe('partial');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('apiLogout surfaces durable server failure while always evicting locally', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: 'postgres unavailable' }, false, 500));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await apiLogout();

    expect(outcome).toMatchObject({ kind: 'partial' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer access-old');
    expect(headers.get('x-breeze-csrf')).toBe('csrf-test-token');
    expect(headers.get('x-breeze-auth-transition')).toBe('v1');
  });

  it('apiLogout reports complete only after a successful terminal response', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ success: true })));

    await expect(apiLogout()).resolves.toEqual({ kind: 'complete' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('apiLogout remains partial when no authenticated access token is available', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiLogout()).resolves.toMatchObject({ kind: 'partial' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  it.each([
    ['empty body contract', {}],
    ['negative body contract', { success: false }],
    ['non-exact body contract', { success: true, extra: true }],
  ])('apiLogout remains partial for HTTP-ok %s', async (_name, body) => {
    useAuthStore.getState().login(baseUser, baseTokens);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(body)));

    await expect(apiLogout()).resolves.toMatchObject({ kind: 'partial' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('accepts only the exact same-origin ticketed Cloudflare navigation URL', () => {
    const origin = window.location.origin;
    expect(validateCfTerminalNavigationUrl('/api/v1/auth/cf-access-logout?ticket=signed.ticket'))
      .toBe('/api/v1/auth/cf-access-logout?ticket=signed.ticket');
    expect(validateCfTerminalNavigationUrl(
      `${origin}/api/v1/auth/cf-access-logout?ticket=signed.ticket`,
    )).toBe('/api/v1/auth/cf-access-logout?ticket=signed.ticket');
    for (const unsafe of [
      'https://evil.example/api/v1/auth/cf-access-logout?ticket=signed.ticket',
      '/api/v1/auth/cf-access-logout',
      '/api/v1/auth/cf-access-logout?ticket=',
      '/api/v1/auth/cf-access-logout?ticket=one&ticket=two',
      '/api/v1/auth/cf-access-logout?ticket=one&next=/evil',
      '/api/v1/auth/cf-access-logout/complete?ticket=one',
      '/api/v1/auth/cf-access-logout?ticket=one#fragment',
      `https://user@${window.location.host}/api/v1/auth/cf-access-logout?ticket=one`,
    ]) {
      expect(validateCfTerminalNavigationUrl(unsafe)).toBeNull();
    }
  });

  it('prepares CF terminal logout, validates navigation, and then evicts local state', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({
      navigationUrl: '/api/v1/auth/cf-access-logout?ticket=signed.ticket',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await apiPrepareCfTerminalLogout();

    expect(outcome).toEqual({
      kind: 'ready', navigationUrl: '/api/v1/auth/cf-access-logout?ticket=signed.ticket',
    });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/cf-access-logout/prepare');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer access-old');
    expect(headers.get('x-breeze-csrf')).toBe('csrf-test-token');
    expect(headers.get('x-breeze-auth-transition')).toBe('v1');
  });

  it('fails closed on prepare errors or invalid navigation and still evicts locally', async () => {
    for (const response of [
      makeResponse({ error: 'postgres unavailable' }, false, 503),
      makeResponse({ navigationUrl: '/api/v1/auth/cf-access-logout' }),
      makeResponse({ navigationUrl: 'https://evil.example/api/v1/auth/cf-access-logout?ticket=x' }),
    ]) {
      useAuthStore.getState().login(baseUser, baseTokens);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(apiPrepareCfTerminalLogout()).resolves.toMatchObject({ kind: 'partial' });
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    }
  });

  it('allows a signed-out retry to use only an explicitly retained in-memory access token', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ error: 'postgres unavailable' }, false, 503))
      .mockResolvedValueOnce(makeResponse({
        navigationUrl: '/api/v1/auth/cf-access-logout?ticket=retry.ticket',
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiPrepareCfTerminalLogout()).resolves.toMatchObject({ kind: 'partial' });
    expect(useAuthStore.getState().tokens).toBeNull();
    await expect(apiPrepareCfTerminalLogout('access-old')).resolves.toEqual({
      kind: 'ready', navigationUrl: '/api/v1/auth/cf-access-logout?ticket=retry.ticket',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows ordinary signed-out retry with an explicitly retained in-memory access token', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ error: 'postgres unavailable' }, false, 500))
      .mockResolvedValueOnce(makeResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiLogout()).resolves.toMatchObject({ kind: 'partial' });
    await expect(apiLogout('access-old')).resolves.toEqual({ kind: 'complete' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('apiLogout resolves on its own 8s timeout when the logout request never settles', async () => {
    // The idle-logout path awaits apiLogout() BEFORE handleSessionExpired('idle'):
    // AdminSessionManager sets idleLogoutInFlightRef + "Signing you out…" first,
    // so a hung /auth/logout would strand that modal forever and permanently
    // gate the heartbeat and the countdown tick. The server-side revoke is
    // best-effort; the client eviction must never wait on it.
    vi.useFakeTimers();
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      let captured: AbortSignal | undefined;
      const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        captured = opts.signal as AbortSignal;
        // Mirror real fetch: reject when the abort fires, never otherwise.
        return new Promise<Response>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      let settled = false;
      const pending = apiLogout().then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(captured?.aborted).toBe(false);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(8000);
      await pending;

      expect(captured?.aborted).toBe(true);
      expect(settled).toBe(true);
      // And the client-side eviction actually happened.
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().tokens).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it('retries a binding 428 exactly once inside one refresh attempt', async () => {
    const refreshed: Tokens = { accessToken: 'access-after-binding', expiresInSeconds: 3600 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ reason: 'auth_binding_rotation_required' }, false, 428))
      .mockResolvedValueOnce(makeResponse({ tokens: refreshed }, true, 200));
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreAccessTokenFromCookie();

    expect(restored).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(new Headers(init.headers).get('x-breeze-auth-transition')).toBe('v1');
    }
  });

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

  // #4097 gave the server a per-binding issuance lease, and the LOSER of two
  // concurrent /auth/refresh calls now gets a bare 409 instead of the
  // 401 {reason:'refresh_raced'} it used to get. Same benign race, new status.
  it('retries refresh once when the server reports the race as a 409, then succeeds', async () => {
    const refreshed: Tokens = { accessToken: 'access-after-409', expiresInSeconds: 3600 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ error: 'Authentication issuance unavailable' }, false, 409))
      .mockResolvedValueOnce(makeResponse({ tokens: refreshed }, true, 200));
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreAccessTokenFromCookie();

    expect(restored).toBe(true);
    // First attempt lost the lease; the second (retry) won — exactly one retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().tokens?.accessToken).toBe('access-after-409');
  });

  // THE ORG-SWITCH LOGOUT. applyOrgSwitch (lib/orgSwitch.ts) ends in a full
  // reload; the reloaded page's bootstrap refresh races the pre-reload one that
  // the unload aborted client-side but the server is still executing under its
  // issuance lease. The loser's 409 must not evict a session that is alive.
  it('does not evict on a 409 during the bootstrap refresh (org switch, #4097)', async () => {
    const { replace, restore } = mockLocation('/devices');
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const refreshed: Tokens = { accessToken: 'access-after-409-bootstrap', expiresInSeconds: 3600 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ error: 'Authentication issuance unavailable' }, false, 409))
        .mockResolvedValueOnce(makeResponse({ tokens: refreshed }, true, 200))
        .mockResolvedValue(makeResponse({ devices: [] }, true, 200));
      vi.stubGlobal('fetch', fetchMock);

      const response = await fetchWithAuth('/devices');

      expect(response.ok).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().sessionExpiredReason).toBeNull();
      expect(replace).not.toHaveBeenCalled();
      expect(useAuthStore.getState().tokens?.accessToken).toBe('access-after-409-bootstrap');
    } finally {
      restore();
    }
  });

  // The raced retry waits a FIXED 200ms. When the winner's issuance
  // transaction is still holding the lease past that (DB/pool contention), the
  // second attempt races too — and evicting there is the same org-switch
  // logout, just rarer. A repeated race is still not a verdict on the refresh
  // cookie, so it belongs in the bounded transient ladder, not in auth-failed.
  it('backs off instead of expiring the session when the race repeats (#4167)', async () => {
    const { replace, restore } = mockLocation('/devices');
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      useAuthStore.getState().setTokens(null);

      const refreshed: Tokens = { accessToken: 'access-after-double-409', expiresInSeconds: 3600 };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ error: 'Authentication issuance unavailable' }, false, 409))
        .mockResolvedValueOnce(makeResponse({ error: 'Authentication issuance unavailable' }, false, 409))
        .mockResolvedValueOnce(makeResponse({ tokens: refreshed }, true, 200))
        .mockResolvedValue(makeResponse({ devices: [] }, true, 200));
      vi.stubGlobal('fetch', fetchMock);

      const response = await fetchWithAuth('/devices');

      expect(response.ok).toBe(true);
      expect(useAuthStore.getState().tokens?.accessToken).toBe('access-after-double-409');
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().sessionExpiredReason).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  // The other direction: backing off must stay BOUNDED. A race that never
  // clears has to end in a verdict, inside the existing transient cap — no new
  // counter, no unbounded loop. (The 401 shape's cap is covered above; this is
  // the 409 shape's.) Two calls per pass (attempt + raced retry) x three
  // passes = the hard ceiling of six /auth/refresh requests.
  it('still gives up within the transient cap when the 409 race never clears', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ error: 'Authentication issuance unavailable' }, false, 409));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await restoreAccessTokenFromCookieDetailed();

    expect(outcome).toBe('transient');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  // Was "gives up after a single retry": a repeated race now backs off into
  // the bounded transient ladder instead of evicting (#4167). It must still
  // END — same ceiling as the 409 shape above, two calls per pass across the
  // three passes MAX_TRANSIENT_REFRESH_RETRIES allows.
  it('gives up within the transient cap if the race persists (no infinite loop)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(racedResponse());
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreAccessTokenFromCookie();

    expect(restored).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(6);
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

describe('restoreAccessTokenFromCookieDetailed (Task 3 — proactive keepalive)', () => {
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

  it("returns 'restored' and stores the tokens on a 200", async () => {
    const refreshed: Tokens = { accessToken: 'access-restored', expiresInSeconds: 3600 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ tokens: refreshed }, true, 200)));

    const outcome = await restoreAccessTokenFromCookieDetailed();

    expect(outcome).toBe('restored');
    expect(useAuthStore.getState().tokens?.accessToken).toBe('access-restored');
  });

  it("returns 'auth-failed' on a hard 401 (expired/reused refresh cookie) without storing tokens", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ error: 'Invalid refresh token' }, false, 401))
    );

    const outcome = await restoreAccessTokenFromCookieDetailed();

    expect(outcome).toBe('auth-failed');
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  it("returns 'auth-failed' when a raced retry lands on a hard failure", async () => {
    const racedResponse = (): Response =>
      ({
        ok: false,
        status: 401,
        json: vi.fn().mockResolvedValue({ error: 'Refresh already in progress', reason: 'refresh_raced' })
      }) as unknown as Response;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(racedResponse())
        .mockResolvedValueOnce(makeResponse({ error: 'Invalid refresh token' }, false, 401))
    );

    const outcome = await restoreAccessTokenFromCookieDetailed();

    expect(outcome).toBe('auth-failed');
  });

  // Split out from 'auth-failed' so the heartbeat's eviction can carry the
  // reason code the login notice keys off. Still an eviction — the origin can
  // never mint a token — just an honestly-labelled one.
  it("returns 'origin-rejected' on a 403 \"Invalid request origin\"", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ error: 'Invalid request origin' }, false, 403))
    );

    const outcome = await restoreAccessTokenFromCookieDetailed();

    expect(outcome).toBe('origin-rejected');
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  it("returns 'transient' once a 5xx exhausts the retry budget — no verdict on the cookie", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ error: 'bad gateway' }, false, 502)));

    const outcome = await restoreAccessTokenFromCookieDetailed();

    expect(outcome).toBe('transient');
    // Initial attempt + MAX_TRANSIENT_REFRESH_RETRIES (2) = 3 refresh calls.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().tokens).toBeNull();
  });

  it("returns 'restored' once a transient 5xx recovers within the retry budget", async () => {
    const refreshed: Tokens = { accessToken: 'access-after-502', expiresInSeconds: 3600 };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ error: 'bad gateway' }, false, 502))
        .mockResolvedValueOnce(makeResponse({ tokens: refreshed }, true, 200))
    );

    const outcome = await restoreAccessTokenFromCookieDetailed();

    expect(outcome).toBe('restored');
    expect(useAuthStore.getState().tokens?.accessToken).toBe('access-after-502');
  });

  it("restoreAccessTokenFromCookie still returns a plain boolean (thin wrapper)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ error: 'Invalid refresh token' }, false, 401))
    );

    await expect(restoreAccessTokenFromCookie()).resolves.toBe(false);
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

  // #4018: this is the proof that `useAuthStore(s => s.user?.hasPassword)`
  // is a REAL runtime signal and not a branch only a test can enter. A prior
  // attempt at the AddDeviceModal SSO copy was correctly reverted precisely
  // because nothing populated this field: /users/me did not return it, so the
  // branch was unreachable in production while a unit test that set the store
  // value directly still went green. These two cases drive the actual
  // hydration path (GET /users/me -> updateUser) end to end.
  it('hydrates hasPassword=false from /users/me for a passwordless SSO account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        id: 'user-1',
        email: 'user@example.com',
        name: 'User One',
        preferences: {},
        partnerId: 'partner-1',
        orgId: null,
        scope: 'partner',
        partnerDefaultLocale: null,
        permissions: [],
        hasPassword: false,
        requiresSetup: false
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(useAuthStore.getState().user?.hasPassword).toBeUndefined();
    await fetchAndApplyPreferences();

    expect(useAuthStore.getState().user?.hasPassword).toBe(false);
  });

  it('hydrates hasPassword=true from /users/me for a password account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        id: 'user-1',
        email: 'user@example.com',
        name: 'User One',
        preferences: {},
        partnerId: 'partner-1',
        orgId: null,
        scope: 'partner',
        partnerDefaultLocale: null,
        permissions: [],
        hasPassword: true,
        requiresSetup: false
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchAndApplyPreferences();

    expect(useAuthStore.getState().user?.hasPassword).toBe(true);
  });

  // A server that has not shipped the field yet must leave the store value
  // ABSENT (unknown), never coerce it to false — false is what flips the UI
  // onto the identity-provider road.
  it('leaves hasPassword absent when /users/me omits it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        id: 'user-1',
        email: 'user@example.com',
        name: 'User One',
        preferences: {},
        partnerId: 'partner-1',
        orgId: null,
        scope: 'partner',
        partnerDefaultLocale: null,
        permissions: [],
        requiresSetup: false
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchAndApplyPreferences();

    expect(useAuthStore.getState().user?.hasPassword).toBeUndefined();
  });
});

describe('apiRegisterPartner recovery action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an https recovery link from a rejection body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse(
          {
            error: 'Please sign up with your business email address.',
            code: 'BUSINESS_EMAIL_REQUIRED',
            actionUrl: 'https://breezermm.com/contact',
            actionLabel: 'Schedule a call'
          },
          false,
          400
        )
      )
    );

    const result = await apiRegisterPartner('Acme', 'jane@gmail.com', 'pw', 'Jane');

    expect(result).toMatchObject({
      success: false,
      action: { url: 'https://breezermm.com/contact', label: 'Schedule a call' }
    });
  });

  it.each([
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a data: scheme', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path', '/contact']
  ])('drops %s rather than rendering it as an href', async (_label, actionUrl) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(makeResponse({ error: 'nope', actionUrl, actionLabel: 'Go' }, false, 400))
    );

    const result = await apiRegisterPartner('Acme', 'jane@gmail.com', 'pw', 'Jane');

    expect(result).toEqual({ success: false, error: 'nope', action: undefined });
  });

  it('omits the action when the body carries no next step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ error: 'Registration failed' }, false, 400))
    );

    const result = await apiRegisterPartner('Acme', 'jane@acme.test', 'pw', 'Jane');

    expect(result).toEqual({ success: false, error: 'Registration failed', action: undefined });
  });
});

describe('MFA enrollment API bindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().login(baseUser, baseTokens);
  });

  it('accepts only a fully typed enrollment-options response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({
      allowedMethods: { totp: true, sms: false, passkey: true },
      phoneConfigured: false,
    })));

    await expect(apiGetMfaEnrollmentOptions()).resolves.toEqual({
      success: true,
      options: {
        allowedMethods: { totp: true, sms: false, passkey: true },
        phoneConfigured: false,
      },
    });
  });

  // #4413: /auth/mfa/enable answers 401 for "that TOTP is wrong", which is not
  // an expired bearer. Letting fetchWithAuth's generic 401 path have it either
  // replays the code or — on the forced-enrollment page, where the user has
  // nowhere else to go — signs them out for a typo.
  it('treats a wrong-code 401 as a rejection, not an expired session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ error: 'Invalid MFA code' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiEnableTotpMfa('123456', 'password')).resolves.toEqual({
      success: false,
      error: 'Invalid MFA code',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh, no replay
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('rejects terminal enrollment responses without replacement access metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({
      success: true,
      recoveryCodes: ['RC-ONE'],
    })));

    await expect(apiEnableTotpMfa('123456', 'password')).resolves.toEqual({
      success: false,
      error: 'Invalid MFA enrollment response',
    });
  });

  it.each([
    ['totp', () => apiEnableTotpMfa('123456', 'password')],
    ['sms', () => apiEnableSmsMfa('password')],
  ] as const)('returns recovery codes and replacement metadata for %s', async (_method, invoke) => {
    const payload = {
      success: true,
      recoveryCodes: ['RC-ONE', 'RC-TWO'],
      tokens: { accessToken: 'replacement', expiresInSeconds: 900 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(payload)));

    await expect(invoke()).resolves.toEqual(payload);
  });

  it('completes passkey registration through the terminal replacement response', async () => {
    const payload = {
      success: true,
      recoveryCodes: ['RC-PASSKEY'],
      tokens: { accessToken: 'replacement-passkey', expiresInSeconds: 900 },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeResponse({ options: { challenge: 'challenge' } }))
      .mockResolvedValueOnce(makeResponse(payload)));

    await expect(apiEnrollPasskey('password')).resolves.toEqual(payload);
  });
});

describe('MFA enrollment session adoption', () => {
  it('refuses a terminal response after logout', () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const generation = useAuthStore.getState().sessionGeneration;
    useAuthStore.getState().logout();

    expect(useAuthStore.getState().commitMfaEnrollmentIfCurrent(generation, {
      accessToken: 'stale',
      expiresInSeconds: 900,
    })).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ user: null, tokens: null, isAuthenticated: false });
  });

  it('refuses a terminal response after a newer login, even for the same user', () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const generation = useAuthStore.getState().sessionGeneration;
    const newerTokens = { accessToken: 'newer', expiresInSeconds: 900 };
    useAuthStore.getState().login(baseUser, newerTokens);

    expect(useAuthStore.getState().commitMfaEnrollmentIfCurrent(generation, {
      accessToken: 'stale',
      expiresInSeconds: 900,
    })).toBe(false);
    expect(useAuthStore.getState().tokens).toEqual(newerTokens);
    expect(useAuthStore.getState().user?.mfaEnabled).toBe(false);
  });
});

describe('replacement-session adoption (#4480)', () => {
  it('installs the replacement tokens on the live session without touching the user record', () => {
    useAuthStore.getState().login({ ...baseUser, mfaEnabled: true }, baseTokens);
    const generation = useAuthStore.getState().sessionGeneration;
    const rotated = { accessToken: 'rotated', expiresInSeconds: 900 };

    expect(useAuthStore.getState().commitReissuedSessionIfCurrent(generation, rotated)).toBe(true);
    expect(useAuthStore.getState().tokens).toEqual(rotated);
    expect(useAuthStore.getState().user).toEqual({ ...baseUser, mfaEnabled: true });
    // Adopting a replacement is not a new session — nothing else may re-run.
    expect(useAuthStore.getState().sessionGeneration).toBe(generation);
  });

  it('refuses a replacement after logout rather than resurrecting the session', () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const generation = useAuthStore.getState().sessionGeneration;
    useAuthStore.getState().logout();

    expect(useAuthStore.getState().commitReissuedSessionIfCurrent(generation, {
      accessToken: 'rotated',
      expiresInSeconds: 900,
    })).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ tokens: null, isAuthenticated: false });
  });

  it('refuses a replacement that lost a race with a newer login', () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const generation = useAuthStore.getState().sessionGeneration;
    const newerTokens = { accessToken: 'newer', expiresInSeconds: 900 };
    useAuthStore.getState().login(baseUser, newerTokens);

    expect(useAuthStore.getState().commitReissuedSessionIfCurrent(generation, {
      accessToken: 'rotated',
      expiresInSeconds: 900,
    })).toBe(false);
    expect(useAuthStore.getState().tokens).toEqual(newerTokens);
  });
});
