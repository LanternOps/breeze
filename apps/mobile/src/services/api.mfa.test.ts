import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn().mockResolvedValue('https://example.invalid') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn().mockResolvedValue('device-1') }));

import { login, onReauthenticationRequired, verifyMfa } from './api';

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
});
