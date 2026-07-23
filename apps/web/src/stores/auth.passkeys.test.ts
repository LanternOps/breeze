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

import { StepUpError, apiLogin, apiVerifyPasskeyMFA, mintAddFactorStepUpGrant, mintStepUpGrants, useAuthStore } from './auth';

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
      // #2153: normalized to false when the login body omits the flag.
      passkeyAvailable: false,
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

describe('mintAddFactorStepUpGrant (SR2-20 add_factor step-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
    // An authenticated session so fetchWithAuth attaches the Bearer token
    // instead of attempting a cookie-based refresh.
    useAuthStore.setState({
      user: baseUser,
      tokens: baseTokens,
      isAuthenticated: true,
      isLoading: false,
      mfaPending: false,
      mfaTempToken: null,
    });
  });

  it('proves a TOTP code and returns the minted grant id', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({ grants: [{ operation: 'add_factor', stepUpGrantId: 'grant-1' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const grantId = await mintAddFactorStepUpGrant({ method: 'totp', code: '123456' });

    expect(grantId).toBe('grant-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/mfa/step-up');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      method: 'totp',
      code: '123456',
      operations: ['add_factor'],
    });
  });

  it('runs the assertion ceremony against the authenticated challenge for the passkey method', async () => {
    const credential = { id: 'credential-1', type: 'public-key' };
    const options = { challenge: 'challenge-b64url', allowCredentials: [{ id: 'credential-1', type: 'public-key' }] };
    webauthnMocks.startAuthentication.mockResolvedValueOnce(credential);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ options }))
      .mockResolvedValueOnce(
        makeResponse({ grants: [{ operation: 'add_factor', stepUpGrantId: 'grant-2' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const grantId = await mintAddFactorStepUpGrant({ method: 'passkey' });

    expect(grantId).toBe('grant-2');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/mfa/step-up/options');
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/mfa/step-up');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      method: 'passkey',
      credential,
      operations: ['add_factor'],
    });
  });

  it('throws a StepUpError carrying the status when the factor proof is rejected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: 'Invalid credentials' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mintAddFactorStepUpGrant({ method: 'totp', code: '000000' })).rejects.toMatchObject({
      name: 'StepUpError',
      message: 'Invalid credentials',
      status: 401,
    });
    await expect(
      mintAddFactorStepUpGrant({ method: 'totp', code: '000000' }).catch((e) => e instanceof StepUpError),
    ).resolves.toBe(true);
  });

  it('throws when the server responds 2xx without a grant id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mintAddFactorStepUpGrant({ method: 'totp', code: '123456' })).rejects.toThrow('Verification failed.');
  });

  it('mints grants for multiple operations from one proof', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({
      grants: [
        { operation: 'add_factor', stepUpGrantId: 'g-add' },
        { operation: 'register_approver_device', stepUpGrantId: 'g-reg' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const grants = await mintStepUpGrants({ method: 'totp', code: '123456' }, ['add_factor', 'register_approver_device']);
    expect(grants).toEqual({ add_factor: 'g-add', register_approver_device: 'g-reg' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      method: 'totp', code: '123456',
      operations: ['add_factor', 'register_approver_device'],
    });
  });

  it('throws StepUpError when a requested grant is missing from the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse({ grants: [] })));
    await expect(mintStepUpGrants({ method: 'totp', code: '123456' }, ['add_factor'])).rejects.toMatchObject({ name: 'StepUpError' });
  });
});
