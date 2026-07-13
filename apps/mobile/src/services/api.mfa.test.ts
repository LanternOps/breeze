import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  getItemAsync: (...args: unknown[]) => secureStore.getItemAsync(...args),
  setItemAsync: (...args: unknown[]) => secureStore.setItemAsync(...args),
}));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn().mockResolvedValue('https://example.invalid') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn().mockResolvedValue('device-1') }));

import {
  captureSessionGeneration,
  getAlerts,
  onDeviceBlocked,
  isCurrentSessionGeneration,
  login,
  onReauthenticationRequired,
  refreshToken,
  verifyMfa,
} from './api';
import { advanceSessionGeneration, terminateSessionGeneration } from './sessionGeneration';

const response = (payload: unknown) => ({
  ok: true,
  status: 200,
  text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
}) as unknown as Response;

describe('mobile MFA contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureStore.values.clear();
    secureStore.getItemAsync.mockImplementation(async (key: string) => secureStore.values.get(key) ?? null);
    secureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      secureStore.values.set(key, value);
    });
  });

  it('persists a first-use native binding and retries the original login exactly once', async () => {
    const nativeBinding = 'b'.repeat(64);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }),
        { status: 428, headers: { 'x-breeze-native-auth-binding': nativeBinding } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: 'u1', email: 'user@example.com', name: 'User', role: 'admin' },
        tokens: { accessToken: 'access-a' },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(login('user@example.com', 'password')).resolves.toMatchObject({
      kind: 'success', token: 'access-a',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(secureStore.setItemAsync).toHaveBeenCalledOnce();
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'breeze_native_auth_binding_v1',
      nativeBinding,
      { keychainAccessible: 'when-unlocked-this-device-only' },
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toEqual(expect.objectContaining({
      'x-breeze-native-auth-binding': nativeBinding,
    }));
  });

  it('sends the persisted binding on MFA and refresh issuers without bootstrapping again', async () => {
    const nativeBinding = 'c'.repeat(64);
    secureStore.values.set('breeze_native_auth_binding_v1', nativeBinding);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: 'u1', email: 'user@example.com', name: 'User', role: 'admin' },
        tokens: { accessToken: 'mfa-access' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tokens: { accessToken: 'refresh-access' },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await verifyMfa('123456', 'temp-1', 'totp');
    await refreshToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual(expect.objectContaining({
        'x-breeze-native-auth-binding': nativeBinding,
      }));
    }
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['MFA', () => verifyMfa('123456', 'temp-1', 'totp'), {
      user: { id: 'u1', email: 'user@example.com', name: 'User', role: 'admin' },
      tokens: { accessToken: 'mfa-access' },
    }],
    ['refresh', () => refreshToken(), { tokens: { accessToken: 'refresh-access' } }],
  ])('bootstraps and retries the original %s issuer exactly once', async (_label, invoke, successPayload) => {
    const nativeBinding = '9'.repeat(64);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 428,
        headers: { 'x-breeze-native-auth-binding': nativeBinding },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(successPayload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(invoke()).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toEqual(expect.objectContaining({
      'x-breeze-native-auth-binding': nativeBinding,
    }));
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-signed-binding'],
  ])('does not persist or retry a 428 with a %s native challenge', async (_label, challenge) => {
    const headers = challenge ? { 'x-breeze-native-auth-binding': challenge } : undefined;
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 428, headers }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(login('user@example.com', 'password')).rejects.toMatchObject({ statusCode: 428 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('reuses one server binding across an account switch', async () => {
    const nativeBinding = 'd'.repeat(64);
    const user = (id: string, email: string) => ({ id, email, name: id, role: 'admin' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 428,
        headers: { 'x-breeze-native-auth-binding': nativeBinding },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: user('a', 'a@example.com'), accessToken: 'a' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: user('b', 'b@example.com'), accessToken: 'b' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await login('a@example.com', 'password-a');
    await login('b@example.com', 'password-b');

    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toEqual(expect.objectContaining({
      'x-breeze-native-auth-binding': nativeBinding,
    }));
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 428 more than once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 428,
        headers: { 'x-breeze-native-auth-binding': 'e'.repeat(64) },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'still stale' }), {
        status: 428,
        headers: { 'x-breeze-native-auth-binding': 'f'.repeat(64) },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(login('user@example.com', 'password')).rejects.toMatchObject({ statusCode: 428 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels a queued bootstrap retry at a terminal session boundary', async () => {
    let releaseBindingWrite!: () => void;
    secureStore.setItemAsync.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseBindingWrite = resolve;
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 428,
      headers: { 'x-breeze-native-auth-binding': 'a'.repeat(64) },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = login('user@example.com', 'password');
    await vi.waitFor(() => expect(releaseBindingWrite).toBeTypeOf('function'));
    terminateSessionGeneration();
    releaseBindingWrite();

    await expect(pending).rejects.toMatchObject({ name: 'SessionGenerationStaleError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('terminalizes a bootstrapped issuer before any later queued transition can run', async () => {
    const listener = vi.fn();
    const off = onReauthenticationRequired(listener);
    const binding = '8'.repeat(64);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', {
        status: 428,
        headers: { 'x-breeze-native-auth-binding': binding },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ reauthenticate: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const terminal = refreshToken();
    const terminalResult = expect(terminal).rejects.toMatchObject({
      name: 'SessionGenerationStaleError',
    });
    const queued = refreshToken();
    const queuedResult = expect(queued).rejects.toMatchObject({
      name: 'SessionGenerationStaleError',
    });
    await terminalResult;
    await queuedResult;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith('security-settings-changed');
    off();
  });

  it('retains the server allowed-method challenge including recovery codes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      mfaRequired: true,
      tempToken: 'temp-1',
      mfaMethod: 'totp',
      allowedMethods: ['totp', 'recovery_code'],
    })));

    await expect(login('user@example.com', 'password')).resolves.toEqual({
      kind: 'mfaRequired',
      challenge: {
        tempToken: 'temp-1',
        mfaMethod: 'totp',
        allowedMethods: ['totp', 'recovery_code'],
        phoneLast4: null,
      },
    });
  });

  it.each([
    [[], []],
    [[null, 'bogus'], []],
    [null, []],
    [{ totp: true }, []],
    ['totp', []],
    [['sms', 'sms', 'bogus'], ['sms']],
  ])('normalizes malformed or empty allowedMethods %#', async (allowedMethods, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      mfaRequired: true,
      tempToken: 'temp-1',
      mfaMethod: 'totp',
      allowedMethods,
    })));

    const result = await login('user@example.com', 'password');
    expect(result.kind === 'mfaRequired' ? result.challenge.allowedMethods : null).toEqual(expected);
  });

  it('uses the legacy primary/recovery fallback only when allowedMethods is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      mfaRequired: true, tempToken: 'temp-1', mfaMethod: 'totp',
    })));
    const result = await login('user@example.com', 'password');
    expect(result.kind === 'mfaRequired' ? result.challenge.allowedMethods : null)
      .toEqual(['totp', 'recovery_code']);
  });

  it('normalizes and submits recovery codes with a method-safe body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      user: { id: 'u1', email: 'user@example.com', name: 'User', role: 'admin' },
      tokens: { accessToken: 'access' },
    })));

    await verifyMfa('ab12cd34', 'temp-1', 'recovery_code');

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      code: 'AB12-CD34',
      tempToken: 'temp-1',
      method: 'recovery_code',
    });
  });

  it.each(['complete', 'partial'])(
    'signals local teardown for a reauthentication response with %s cleanup',
    async (cleanupStatus) => {
      const listener = vi.fn();
      const off = onReauthenticationRequired(listener);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
        success: true,
        reauthenticate: true,
        cleanupStatus,
      })));

      await expect(verifyMfa('123456', 'temp-1', 'totp')).rejects.toMatchObject({
        code: 'reauthentication_required',
      });
      expect(listener).toHaveBeenCalledWith('security-settings-changed');
      off();
    },
  );

  it('rejects an older deferred request after terminal reauthentication advances the session generation', async () => {
    const hydrationGeneration = captureSessionGeneration();
    let resolveAlerts!: (value: Response) => void;
    const alertsResponse = new Promise<Response>((resolve) => { resolveAlerts = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(alertsResponse)
      .mockResolvedValueOnce(response({ reauthenticate: true }));
    vi.stubGlobal('fetch', fetchMock);

    const pendingAlerts = getAlerts();
    while (fetchMock.mock.calls.length < 1) await Promise.resolve();
    await expect(verifyMfa('123456', 'temp-1', 'totp')).rejects.toMatchObject({
      code: 'reauthentication_required',
    });
    expect(isCurrentSessionGeneration(hydrationGeneration)).toBe(false);
    resolveAlerts(response([]));

    await expect(pendingAlerts).rejects.toMatchObject({ code: 'session_generation_stale' });
  });

  it('drops a deferred error body before device-blocked notification after the session changes', async () => {
    let resolveBody!: (body: Record<string, unknown>) => void;
    const blocked = vi.fn();
    const off = onDeviceBlocked(blocked);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403,
      json: vi.fn(() => new Promise((resolve) => { resolveBody = resolve; })),
    }));
    const pending = getAlerts();
    await vi.waitFor(() => expect(resolveBody).toBeTypeOf('function'));
    advanceSessionGeneration();
    resolveBody({ code: 'device_blocked', reason: 'old account' });
    await expect(pending).rejects.toMatchObject({ code: 'session_generation_stale' });
    expect(blocked).not.toHaveBeenCalled();
    off();
  });

  it('drops a deferred success body after logout/account transition', async () => {
    let resolveText!: (text: string) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: vi.fn(() => new Promise((resolve) => { resolveText = resolve; })),
    }));
    const pending = getAlerts();
    await vi.waitFor(() => expect(resolveText).toBeTypeOf('function'));
    advanceSessionGeneration();
    resolveText('[]');
    await expect(pending).rejects.toMatchObject({ code: 'session_generation_stale' });
  });
});
