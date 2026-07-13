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
import { StaleWebSessionError } from './sessionTeardown';

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
      allowedMethods: ['passkey', 'recovery_code'],
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

    expect(result).toMatchObject({
      success: true,
      user: { ...baseUser, requiresSetup: false },
      tokens: baseTokens,
      requiresSetup: false,
    });
    expect(result.installedSession).toMatchObject({ userId: baseUser.id, accessToken: baseTokens.accessToken });
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

  it('discards account A when account B installs while its WebAuthn assertion is pending', async () => {
    let resolveCredential!: (credential: object) => void;
    webauthnMocks.startAuthentication.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCredential = resolve; }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({
      options: { challenge: 'challenge-a', allowCredentials: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const oldVerification = apiVerifyPasskeyMFA('temp-a');
    await vi.waitFor(() => expect(webauthnMocks.startAuthentication).toHaveBeenCalledOnce());
    const userB = { ...baseUser, id: 'user-b', email: 'b@example.com' };
    const tokensB = { accessToken: 'access-b', expiresInSeconds: 3600 };
    useAuthStore.getState().login(userB, tokensB);
    resolveCredential({ id: 'credential-a', type: 'public-key', response: {} });

    await expect(oldVerification).rejects.toBeInstanceOf(StaleWebSessionError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAuthStore.getState()).toMatchObject({ user: userB, tokens: tokensB });
  });

  it('discards account A when account B installs while passkey options are parsing', async () => {
    let resolveOptions!: (body: unknown) => void;
    const optionsJson = vi.fn(() => new Promise<unknown>((resolve) => { resolveOptions = resolve; }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: optionsJson } as unknown as Response));
    const oldVerification = apiVerifyPasskeyMFA('temp-a');
    await vi.waitFor(() => expect(optionsJson).toHaveBeenCalledOnce());
    const userB = { ...baseUser, id: 'user-b', email: 'b@example.com' };
    const tokensB = { accessToken: 'access-b', expiresInSeconds: 3600 };
    useAuthStore.getState().login(userB, tokensB);
    resolveOptions({ options: { challenge: 'challenge-a', allowCredentials: [] } });

    await expect(oldVerification).rejects.toBeInstanceOf(StaleWebSessionError);
    expect(webauthnMocks.startAuthentication).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ user: userB, tokens: tokensB });
  });

  it('discards account A when account B installs while passkey verification is parsing', async () => {
    webauthnMocks.startAuthentication.mockResolvedValueOnce({ id: 'credential-a', type: 'public-key', response: {} });
    let resolveVerify!: (body: unknown) => void;
    const verifyJson = vi.fn(() => new Promise<unknown>((resolve) => { resolveVerify = resolve; }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ options: { challenge: 'challenge-a', allowCredentials: [] } }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: verifyJson } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const oldVerification = apiVerifyPasskeyMFA('temp-a');
    await vi.waitFor(() => expect(verifyJson).toHaveBeenCalledOnce());
    const userB = { ...baseUser, id: 'user-b', email: 'b@example.com' };
    const tokensB = { accessToken: 'access-b', expiresInSeconds: 3600 };
    useAuthStore.getState().login(userB, tokensB);
    resolveVerify({ user: baseUser, tokens: baseTokens });

    await expect(oldVerification).rejects.toBeInstanceOf(StaleWebSessionError);
    expect(useAuthStore.getState()).toMatchObject({ user: userB, tokens: tokensB });
  });

  it('holds the transition for the whole passkey ceremony before newer password login', async () => {
    let resolveCredential!: (credential: object) => void;
    webauthnMocks.startAuthentication.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCredential = resolve; }),
    );
    let resolveVerifyA!: (response: Response) => void;
    let resolveLoginB!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/mfa/passkey/options')) {
        return Promise.resolve(makeResponse({ options: { challenge: 'challenge-a', allowCredentials: [] } }));
      }
      if (url.endsWith('/auth/mfa/passkey/verify')) {
        return new Promise<Response>((resolve) => { resolveVerifyA = resolve; });
      }
      if (url.endsWith('/auth/login')) {
        return new Promise<Response>((resolve) => { resolveLoginB = resolve; });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const passkeyA = apiVerifyPasskeyMFA('temp-a');
    await vi.waitFor(() => expect(webauthnMocks.startAuthentication).toHaveBeenCalledOnce());
    const loginB = apiLogin('b@example.com', 'password-b');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/login'))).toHaveLength(0);

    resolveCredential({ id: 'credential-a', type: 'public-key', response: {} });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/login'))).toHaveLength(0);
    resolveVerifyA(makeResponse({ user: baseUser, tokens: baseTokens }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/login'))).toBe(true));
    const userB = { ...baseUser, id: 'user-b', email: 'b@example.com' };
    const tokensB = { accessToken: 'access-b', expiresInSeconds: 3600 };
    resolveLoginB(makeResponse({ user: userB, tokens: tokensB }));

    await expect(passkeyA).resolves.toMatchObject({ success: true, user: baseUser });
    await expect(loginB).resolves.toMatchObject({ success: true, user: userB });
    expect(useAuthStore.getState()).toMatchObject({ user: userB, tokens: tokensB });
  });
});
