import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const csrf = { forget: vi.fn(async () => undefined) };
vi.mock('./csrfToken', () => ({
  CSRF_TOKEN_KEY: 'breeze_csrf_token',
  applyCsrfSignal: vi.fn(async () => undefined),
  forgetCsrfToken: () => csrf.forget(),
  clearCsrfToken: () => csrf.forget(),
  getCsrfHeaderValue: vi.fn(async () => 'csrf'),
  readCsrfCookie: vi.fn(() => ({ kind: 'absent' })),
}));

import {
  NATIVE_AUTH_BINDING_HEADER,
  NATIVE_AUTH_BINDING_KEY,
  logout,
  refreshToken,
  verifyMfa,
} from './api';
import { commitIfCurrent, currentSessionGeneration } from './sessionGeneration';

function response(status: number, body: unknown = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  secureValues.clear();
  serverConfig.getServerUrl.mockReset().mockResolvedValue('https://api.example.test');
  secureStore.getItemAsync.mockClear();
  secureStore.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => {
    secureValues.set(key, value);
  });
  secureStore.deleteItemAsync.mockReset().mockImplementation(async (key: string) => {
    secureValues.delete(key);
  });
  csrf.forget.mockClear();
  fetchWithTimeout.mockReset();
});

describe('native logout generation fencing', () => {
  it('captures generation before server URL resolution and never sends a superseded issuer', async () => {
    let releaseServerUrl!: (value: string) => void;
    serverConfig.getServerUrl
      .mockImplementationOnce(() => new Promise((resolve) => { releaseServerUrl = resolve; }))
      .mockResolvedValue('https://api.example.test');
    fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith('/auth/logout')) return Promise.resolve(response(204));
      throw new Error(`stale issuer was sent: ${url}`);
    });

    const staleMfa = verifyMfa('123456', 'temp-old', 'totp');
    await vi.waitFor(() => expect(serverConfig.getServerUrl).toHaveBeenCalledTimes(1));
    await logout();
    releaseServerUrl('https://api.example.test');

    await expect(staleMfa).rejects.toMatchObject({ code: 'session_superseded' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not retry a binding bootstrap after logout supersedes its queued persistence', async () => {
    let releaseBindingWrite!: () => void;
    let bindingWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { bindingWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseBindingWrite = resolve; });
    secureStore.setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
      bindingWriteStarted();
      await writeRelease;
      secureValues.set(key, value);
    });
    fetchWithTimeout
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'binding required' }), {
        status: 428,
        headers: {
          'content-type': 'application/json',
          [NATIVE_AUTH_BINDING_HEADER]: 'f'.repeat(64),
        },
      }))
      .mockResolvedValueOnce(response(204));

    const staleMfa = verifyMfa('123456', 'temp-old', 'totp');
    await writeStarted;
    const logoutRequest = logout();
    releaseBindingWrite();
    await logoutRequest;

    await expect(staleMfa).rejects.toMatchObject({ code: 'session_superseded' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(secureValues.has(NATIVE_AUTH_BINDING_KEY)).toBe(false);
  });

  it('does not let an A-session stale CSRF error mutate a replacement B session', async () => {
    let releaseA!: (value: Response) => void;
    const delayedA = new Promise<Response>((resolve) => { releaseA = resolve; });
    fetchWithTimeout.mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith('/auth/mfa/verify')) {
        const body = JSON.parse(String(init.body)) as { tempToken: string };
        if (body.tempToken === 'temp-a') return delayedA;
        return Promise.resolve(response(200, {
          user: { id: 'user-b', email: 'b@example.test', name: 'B', role: 'admin' },
          tokens: { accessToken: 'access-b' },
        }));
      }
      if (url.endsWith('/auth/logout')) return Promise.resolve(response(204));
      throw new Error(`unexpected request ${url}`);
    });

    const staleA = verifyMfa('123456', 'temp-a', 'totp');
    await vi.waitFor(() => expect(fetchWithTimeout).toHaveBeenCalledTimes(1));
    await logout();
    await expect(verifyMfa('654321', 'temp-b', 'totp')).resolves.toMatchObject({ token: 'access-b' });
    releaseA(response(403, { error: 'CSRF token mismatch' }));

    await expect(staleA).rejects.toMatchObject({ code: 'session_superseded' });
    expect(csrf.forget).toHaveBeenCalledTimes(1);
  });

  it('clears token, CSRF mirror, and native binding even when server logout fails', async () => {
    secureValues.set('breeze_auth_token', 'access-old');
    secureValues.set(NATIVE_AUTH_BINDING_KEY, 'a'.repeat(64));
    fetchWithTimeout.mockRejectedValueOnce(new Error('offline'));

    await expect(logout()).resolves.toBeUndefined();

    expect(secureValues.has('breeze_auth_token')).toBe(false);
    expect(secureValues.has(NATIVE_AUTH_BINDING_KEY)).toBe(false);
    expect(csrf.forget).toHaveBeenCalledTimes(1);
  });

  it('prevents a delayed pre-logout MFA response from reinstalling its replacement binding', async () => {
    let releaseMfa!: (value: Response) => void;
    const delayedMfa = new Promise<Response>((resolve) => { releaseMfa = resolve; });
    fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith('/auth/mfa/verify')) return delayedMfa;
      if (url.endsWith('/auth/logout')) return Promise.resolve(response(204));
      throw new Error(`unexpected request ${url}`);
    });

    const staleMfa = verifyMfa('123456', 'temp-old', 'totp');
    await vi.waitFor(() => expect(fetchWithTimeout).toHaveBeenCalledTimes(1));
    await logout();
    releaseMfa(new Response(JSON.stringify({ error: 'binding required' }), {
      status: 428,
      headers: {
        'content-type': 'application/json',
        [NATIVE_AUTH_BINDING_HEADER]: 'd'.repeat(64),
      },
    }));

    await expect(staleMfa).rejects.toMatchObject({ code: 'session_superseded' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(secureValues.has(NATIVE_AUTH_BINDING_KEY)).toBe(false);
  });

  it('orders logout cleanup after an already-running session persistence write', async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const capturedGeneration = currentSessionGeneration();
    const staleWrite = commitIfCurrent(capturedGeneration, async () => {
      markWriteStarted();
      await writeRelease;
      secureValues.set(NATIVE_AUTH_BINDING_KEY, 'e'.repeat(64));
    });
    await writeStarted;
    fetchWithTimeout.mockResolvedValueOnce(response(204));

    const logoutRequest = logout();
    await vi.waitFor(() => expect(fetchWithTimeout).toHaveBeenCalledTimes(1));
    releaseWrite();
    await Promise.all([staleWrite, logoutRequest]);

    expect(secureValues.has(NATIVE_AUTH_BINDING_KEY)).toBe(false);
  });

  it('does not return a delayed pre-logout refresh token for callers to persist', async () => {
    let releaseRefresh!: (value: Response) => void;
    const delayedRefresh = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
    fetchWithTimeout.mockImplementation((url: string) => {
      if (url.endsWith('/auth/refresh')) return delayedRefresh;
      if (url.endsWith('/auth/logout')) return Promise.resolve(response(204));
      throw new Error(`unexpected request ${url}`);
    });

    const staleRefresh = refreshToken();
    await vi.waitFor(() => expect(fetchWithTimeout).toHaveBeenCalledTimes(1));
    await logout();
    releaseRefresh(response(200, { tokens: { accessToken: 'access-stale' } }));

    await expect(staleRefresh).rejects.toMatchObject({ code: 'session_superseded' });
    expect(secureValues.has('breeze_auth_token')).toBe(false);
  });
});
