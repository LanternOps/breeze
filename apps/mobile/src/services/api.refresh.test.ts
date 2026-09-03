import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same harness as api.logout.test.ts: SecureStore, server URL, fetch and CSRF
// are stubbed so `coreRequest` runs end to end against scripted responses.
const secureValues = new Map<string, string>();
const fetchWithTimeout = vi.fn();
const serverConfig = vi.hoisted(() => ({
  getServerUrl: vi.fn(async () => 'https://api.example.test'),
}));
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { secureValues.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { secureValues.delete(key); }),
}));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: (...args: Parameters<typeof secureStore.getItemAsync>) => secureStore.getItemAsync(...args),
  setItemAsync: (...args: Parameters<typeof secureStore.setItemAsync>) => secureStore.setItemAsync(...args),
  deleteItemAsync: (...args: Parameters<typeof secureStore.deleteItemAsync>) => secureStore.deleteItemAsync(...args),
}));
vi.mock('@sentry/react-native', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => serverConfig.getServerUrl() }));
vi.mock('./installationId', () => ({
  getOrCreateInstallationId: vi.fn(async () => 'install-1'),
}));
vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));
vi.mock('./csrfToken', () => ({
  CSRF_TOKEN_KEY: 'breeze_csrf_token',
  applyCsrfSignal: vi.fn(async () => undefined),
  forgetCsrfToken: vi.fn(async () => undefined),
  clearCsrfToken: vi.fn(async () => undefined),
  getCsrfHeaderValue: vi.fn(async () => 'csrf'),
  readCsrfCookie: vi.fn(() => ({ kind: 'absent' })),
}));

import { coreRequest, refreshAccessToken } from './api';
import { AUTH_TOKEN_KEY } from './authSessionKeys';

function response(status: number, body: unknown = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every fetch call as `[method, path, bearer]`, in order. */
function calls(): Array<[string, string, string | undefined]> {
  return fetchWithTimeout.mock.calls.map(([url, init]) => [
    ((init as RequestInit)?.method ?? 'GET').toUpperCase(),
    new URL(url as string).pathname,
    ((init as RequestInit)?.headers as Record<string, string>)?.Authorization,
  ]);
}

beforeEach(() => {
  secureValues.clear();
  secureValues.set(AUTH_TOKEN_KEY, 'stale-token');
  fetchWithTimeout.mockReset();
});

describe('401 -> refresh -> retry on every core request', () => {
  it('refreshes once, persists the new token, and retries the original request with it', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(response(401, { error: 'Invalid token' }))
      .mockResolvedValueOnce(response(200, { tokens: { accessToken: 'fresh-token' } }))
      .mockResolvedValueOnce(response(200, { data: [{ id: 'd1' }] }));

    await expect(coreRequest('/devices?limit=50')).resolves.toEqual({ data: [{ id: 'd1' }] });
    expect(calls()).toEqual([
      ['GET', '/api/v1/devices', 'Bearer stale-token'],
      ['POST', '/api/v1/auth/refresh', 'Bearer stale-token'],
      ['GET', '/api/v1/devices', 'Bearer fresh-token'],
    ]);
    expect(secureValues.get(AUTH_TOKEN_KEY)).toBe('fresh-token');
  });

  it('single-flights: two requests that 401 together share one refresh', async () => {
    let resolveRefresh!: (r: Response) => void;
    fetchWithTimeout.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const bearer = (init?.headers as Record<string, string>)?.Authorization;
      if (path.endsWith('/auth/refresh')) {
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      if (bearer === 'Bearer fresh-token') return Promise.resolve(response(200, { data: path }));
      return Promise.resolve(response(401, { error: 'Invalid token' }));
    });

    const a = coreRequest('/devices');
    const b = coreRequest('/alerts');
    await vi.waitFor(() => expect(calls().filter(([, p]) => p.endsWith('/auth/refresh'))).toHaveLength(1));
    resolveRefresh(response(200, { tokens: { accessToken: 'fresh-token' } }));
    await expect(a).resolves.toEqual({ data: '/api/v1/devices' });
    await expect(b).resolves.toEqual({ data: '/api/v1/alerts' });
    expect(calls().filter(([, p]) => p.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('surfaces the original 401 when the refresh itself fails, without looping', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(response(401, { error: 'Invalid token' }))
      .mockResolvedValueOnce(response(401, { error: 'refresh expired' }));

    await expect(coreRequest('/devices')).rejects.toMatchObject({ statusCode: 401, message: 'Invalid token' });
    expect(calls().map(([, p]) => p)).toEqual(['/api/v1/devices', '/api/v1/auth/refresh']);
  });

  it('retries at most once: a 401 after a successful refresh is final', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(response(401, { error: 'Invalid token' }))
      .mockResolvedValueOnce(response(200, { tokens: { accessToken: 'fresh-token' } }))
      .mockResolvedValueOnce(response(401, { error: 'still no' }));

    await expect(coreRequest('/devices')).rejects.toMatchObject({ statusCode: 401, message: 'still no' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  });

  it('never refreshes for the auth endpoints themselves or when signed out', async () => {
    fetchWithTimeout.mockResolvedValue(response(401, { error: 'bad credentials' }));
    await expect(coreRequest('/auth/login', { method: 'POST', body: '{}' })).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

    fetchWithTimeout.mockClear();
    secureValues.delete(AUTH_TOKEN_KEY);
    await expect(coreRequest('/devices')).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('refreshAccessToken', () => {
  it('returns null (not a throw) when refresh fails, so callers surface their own 401', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(401, { error: 'refresh expired' }));
    await expect(refreshAccessToken()).resolves.toBeNull();
  });
});
