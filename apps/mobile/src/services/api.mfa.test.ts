import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn().mockResolvedValue('https://example.invalid') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn().mockResolvedValue('device-1') }));

import {
  captureSessionGeneration,
  getAlerts,
  onDeviceBlocked,
  isCurrentSessionGeneration,
  login,
  onReauthenticationRequired,
  verifyMfa,
} from './api';
import { advanceSessionGeneration } from './sessionGeneration';

const response = (payload: unknown) => ({
  ok: true,
  status: 200,
  text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
}) as unknown as Response;

describe('mobile MFA contracts', () => {
  beforeEach(() => vi.clearAllMocks());

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
