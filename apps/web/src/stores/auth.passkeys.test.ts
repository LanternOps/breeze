import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tokens, User } from './auth';

const { webauthnMocks } = vi.hoisted(() => ({
  webauthnMocks: {
    startAuthentication: vi.fn(),
    startRegistration: vi.fn(),
  },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: webauthnMocks.startAuthentication,
  startRegistration: webauthnMocks.startRegistration,
}));

import { apiLogin, apiVerifyPasskeyMFA, useAuthStore } from './auth';

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const baseUser: User = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'User One',
  mfaEnabled: true,
};

const baseTokens: Tokens = {
  accessToken: 'access-passkey',
  expiresInSeconds: 3600,
};

describe('auth store passkey MFA helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
    useAuthStore.setState({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null,
    });
  });

  it('apiLogin preserves the passkey MFA method so the login page can branch to WebAuthn', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        mfaRequired: true,
        tempToken: 'temp-passkey',
        mfaMethod: 'passkey',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiLogin('user@example.com', 'password');

    expect(result).toEqual({
      success: true,
      mfaRequired: true,
      tempToken: 'temp-passkey',
      mfaMethod: 'passkey',
      phoneLast4: undefined,
    });
  });

  it('apiVerifyPasskeyMFA fetches options, posts the assertion, and returns MFA-satisfied session data', async () => {
    const credential = {
      id: 'credential-1',
      rawId: 'credential-1',
      type: 'public-key',
      response: {
        authenticatorData: 'auth-data',
        clientDataJSON: 'client-data',
        signature: 'signature',
      },
    };
    webauthnMocks.startAuthentication.mockResolvedValueOnce(credential);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({
        options: {
          challenge: 'challenge-b64url',
          allowCredentials: [{ id: 'credential-1', type: 'public-key' }],
        },
      }))
      .mockResolvedValueOnce(makeResponse({
        user: baseUser,
        tokens: baseTokens,
        requiresSetup: false,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiVerifyPasskeyMFA('temp-passkey');

    expect(result).toEqual({
      success: true,
      user: { ...baseUser, requiresSetup: false },
      tokens: baseTokens,
      requiresSetup: false,
    });
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: {
        challenge: 'challenge-b64url',
        allowCredentials: [{ id: 'credential-1', type: 'public-key' }],
      },
    });
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/v1/auth/mfa/passkey/options',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ tempToken: 'temp-passkey' }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/v1/auth/mfa/passkey/verify',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ tempToken: 'temp-passkey', credential }),
      }),
    ]);
  });
});
