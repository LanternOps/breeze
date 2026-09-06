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
  login,
  NATIVE_AUTH_BINDING_KEY,
  NATIVE_AUTH_BINDING_HEADER,
  parseMfaChallengePayload,
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

    await expect(verifyMfa('123456', 'temp-1', 'totp')).resolves.toMatchObject({ token: 'access-1' });

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

    await verifyMfa('123456', 'temp-2', 'totp');

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

    await expect(verifyMfa('123456', 'temp-3', 'totp')).rejects.toMatchObject({ statusCode: 428 });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(secureValues.get(NATIVE_AUTH_BINDING_KEY)).toBe(replacement);
  });
});

describe('mobile MFA response contracts', () => {
  it('normalizes the strict challenge contract including passkey and recovery', () => {
    expect(parseMfaChallengePayload({
      mfaRequired: true,
      tempToken: 'temp-1',
      mfaMethod: 'passkey',
      allowedMethods: { totp: true, sms: false, passkey: true },
      recoveryAvailable: true,
      passkeyAvailable: true,
    })).toEqual({
      tempToken: 'temp-1',
      mfaMethod: 'passkey',
      methods: ['totp', 'passkey', 'recovery'],
      allowedMethods: { totp: true, sms: false, passkey: true },
      recoveryAvailable: true,
      phoneLast4: null,
    });
  });

  it('fails closed when strict challenge aliases disagree', () => {
    expect(parseMfaChallengePayload({
      tempToken: 'temp-1',
      mfaMethod: 'totp',
      methods: ['totp'],
      allowedMethods: ['sms'],
      recoveryAvailable: false,
    })).toBeNull();
  });

  it('keeps legacy challenges compatible only when both method lists are absent', () => {
    expect(parseMfaChallengePayload({ mfaRequired: true, tempToken: 'temp-1', mfaMethod: 'sms' })).toEqual({
      tempToken: 'temp-1',
      mfaMethod: 'sms',
      methods: ['sms'],
      allowedMethods: { totp: false, sms: true, passkey: false },
      recoveryAvailable: false,
      phoneLast4: null,
    });
  });

  it('treats enrollment-required as unauthenticated even if tokens are present', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(200, {
      mfaEnrollmentRequired: true,
      enrollUrl: '/auth/mfa/setup',
      user,
      tokens: { accessToken: 'must-not-be-used' },
    }));

    await expect(login('tech@example.test', 'pw')).resolves.toEqual({
      kind: 'mfaEnrollmentRequired',
      handoff: { reason: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' },
    });
  });

  it('sends the selected method and preserves recovery-code separators', async () => {
    fetchWithTimeout.mockResolvedValueOnce(response(200, {
      user,
      tokens: { accessToken: 'access-recovery' },
    }));

    await verifyMfa('ABCD EFGH-IJKL', 'temp-recovery', 'recovery');

    expect(JSON.parse(String(fetchWithTimeout.mock.calls[0]![1].body))).toEqual({
      code: 'ABCD EFGH-IJKL',
      tempToken: 'temp-recovery',
      method: 'recovery',
    });
  });
});
