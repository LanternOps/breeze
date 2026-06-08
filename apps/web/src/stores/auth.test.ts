import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tokens, User } from './auth';
import {
  apiAcceptInvite,
  apiLogin,
  apiLogout,
  apiPreviewInvite,
  apiResetPassword,
  apiVerifyMFA,
  fetchWithAuth,
  restoreAccessTokenFromCookie,
  useAuthStore,
  waitForPendingRefresh
} from './auth';

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
      phoneLast4: '1234'
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
