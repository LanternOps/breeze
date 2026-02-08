import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tokens, User } from './auth';
import { apiLogin, apiLogout, apiVerifyMFA, fetchWithAuth, useAuthStore } from './auth';

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
  refreshToken: 'refresh-1',
  expiresInSeconds: 3600
};

describe('auth store fetchWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
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
    expect(url).toBe('http://localhost:3001/api/v1/devices');

    const headers = options.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${baseTokens.accessToken}`);
    expect(headers.get('Content-Type')).toBe('application/json');
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
    expect(firstUrl).toBe('http://localhost:3001/api/v1/devices');
    expect(secondUrl).toBe('http://localhost:3001/api/v1/api-keys');
  });

  it('refreshes and retries when access token is expired', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const refreshedTokens: Tokens = {
      accessToken: 'access-new',
      refreshToken: 'refresh-2',
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
    expect(refreshCall[0]).toBe('http://localhost:3001/api/v1/auth/refresh');
    expect(refreshCall[1].method).toBe('POST');
    expect(refreshCall[1].body).toBe(JSON.stringify({ refreshToken: baseTokens.refreshToken }));

    const retryCall = fetchMock.mock.calls[2] as [string, RequestInit];
    const retryHeaders = retryCall[1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe(`Bearer ${refreshedTokens.accessToken}`);
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
});

describe('auth API helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
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
      refreshToken: 'refresh-new',
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

    expect(result).toEqual({ success: true, user: baseUser, tokens });
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
});
