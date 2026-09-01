import { beforeEach, describe, expect, it, vi } from 'vitest';

// Caller-level regression test for #4002: a SecureStore read failure for the
// configured server URL must fail the request, not silently reroute it to
// FALLBACK_API_BASE_URL (the hosted US host). This exercises the real
// `requestWithPrefix` code path (via the exported `login`), not just the
// `serverConfig` unit in isolation, since the bug was in how a caller
// combined `getServerUrl()` with `|| FALLBACK_API_BASE_URL`.

const secureValues = new Map<string, string>();
const fetchWithTimeout = vi.fn();
const serverConfig = vi.hoisted(() => ({
  getServerUrl: vi.fn(async (): Promise<string | null> => 'https://api.example.test'),
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
// Real ServerUrlReadError so `.name`/`instanceof` assertions below match
// production behavior, not a mock shape.
vi.mock('./serverConfig', async () => {
  const actual = await vi.importActual<typeof import('./serverConfig')>('./serverConfig');
  return {
    ...actual,
    getServerUrl: () => serverConfig.getServerUrl(),
  };
});
vi.mock('./installationId', () => ({
  getOrCreateInstallationId: vi.fn(async () => 'install-1'),
}));
vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));
vi.mock('./csrfToken', () => ({
  applyCsrfSignal: vi.fn(async () => undefined),
  forgetCsrfToken: vi.fn(async () => undefined),
  getCsrfHeaderValue: vi.fn(async () => 'csrf'),
  readCsrfCookie: vi.fn(() => ({ kind: 'absent' })),
}));

import { login, FALLBACK_API_BASE_URL } from './api';
import { ServerUrlReadError } from './serverConfig';

beforeEach(() => {
  secureValues.clear();
  serverConfig.getServerUrl.mockReset().mockResolvedValue('https://api.example.test');
  secureStore.getItemAsync.mockClear();
  fetchWithTimeout.mockReset();
});

describe('auth path fails closed on a server-URL read failure (#4002)', () => {
  it('rejects login() with ServerUrlReadError instead of falling back to FALLBACK_API_BASE_URL', async () => {
    serverConfig.getServerUrl.mockReset().mockRejectedValue(new ServerUrlReadError(new Error('keychain locked')));

    await expect(login('tech@example.test', 'password')).rejects.toBeInstanceOf(ServerUrlReadError);

    // The request must never go out at all — least of all to the hosted
    // fallback host — once the configured server can't be determined.
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('sanity check: a genuinely unconfigured server (null) still reaches FALLBACK_API_BASE_URL', async () => {
    serverConfig.getServerUrl.mockReset().mockResolvedValue(null);
    fetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify({ error: 'no server configured' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(login('tech@example.test', 'password')).rejects.toBeTruthy();

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url] = fetchWithTimeout.mock.calls[0] as [string, unknown];
    expect(url.startsWith(FALLBACK_API_BASE_URL)).toBe(true);
  });
});
