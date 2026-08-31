import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureValues = new Map<string, string>();
const fetchWithTimeout = vi.fn();

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { secureValues.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { secureValues.delete(key); }),
}));
vi.mock('@sentry/react-native', () => ({ captureMessage: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn(async () => 'https://api.example.test') }));
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

import {
  NATIVE_AUTH_BINDING_KEY,
  NATIVE_AUTH_BINDING_HEADER,
  verifyMfa,
} from './api';

const replacement = 'a'.repeat(64);
const user = {
  id: 'user-1', email: 'tech@example.test', name: 'Tech', role: 'technician',
};

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function requestHeaders(callIndex: number): Record<string, string> {
  return fetchWithTimeout.mock.calls[callIndex]![1].headers as Record<string, string>;
}

beforeEach(() => {
  secureValues.clear();
  fetchWithTimeout.mockReset();
});

describe('native MFA transition transport', () => {
  it('signals transition-v1, persists a 428 replacement, and retries exactly once', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(response(428, { error: 'binding required' }, {
        [NATIVE_AUTH_BINDING_HEADER]: replacement,
      }))
      .mockResolvedValueOnce(response(200, {
        user,
        tokens: { accessToken: 'access-1' },
      }));

    await expect(verifyMfa('123456', 'temp-1')).resolves.toMatchObject({ token: 'access-1' });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(requestHeaders(0)).toMatchObject({
      'x-breeze-auth-transition': 'v1',
      'x-breeze-mobile-device-id': 'install-1',
    });
    expect(requestHeaders(0)).not.toHaveProperty(NATIVE_AUTH_BINDING_HEADER);
    expect(requestHeaders(1)[NATIVE_AUTH_BINDING_HEADER]).toBe(replacement);
    expect(secureValues.get(NATIVE_AUTH_BINDING_KEY)).toBe(replacement);
  });

  it('uses the persisted signed binding on subsequent native issuer requests', async () => {
    secureValues.set(NATIVE_AUTH_BINDING_KEY, replacement);
    fetchWithTimeout.mockResolvedValueOnce(response(200, {
      user,
      tokens: { accessToken: 'access-2' },
    }));

    await verifyMfa('123456', 'temp-2');

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(requestHeaders(0)).toMatchObject({
      'x-breeze-auth-transition': 'v1',
      [NATIVE_AUTH_BINDING_HEADER]: replacement,
    });
  });

  it('replaces a stale install binding but never retries a second 428', async () => {
    secureValues.set(NATIVE_AUTH_BINDING_KEY, 'b'.repeat(64));
    fetchWithTimeout
      .mockResolvedValueOnce(response(428, { error: 'binding rotated' }, {
        [NATIVE_AUTH_BINDING_HEADER]: replacement,
      }))
      .mockResolvedValueOnce(response(428, { error: 'still rejected' }, {
        [NATIVE_AUTH_BINDING_HEADER]: 'c'.repeat(64),
      }));

    await expect(verifyMfa('123456', 'temp-3')).rejects.toMatchObject({ statusCode: 428 });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(secureValues.get(NATIVE_AUTH_BINDING_KEY)).toBe(replacement);
  });
});
