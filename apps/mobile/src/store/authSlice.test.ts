import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

// Mock the service layer so importing authSlice never pulls expo-secure-store
// (the node-only vitest runtime can't parse the native modules) and so we can
// drive the four logoutAsync outcomes deterministically.
const api = {
  logout: vi.fn(),
  login: vi.fn(),
  verifyMfa: vi.fn(),
};
vi.mock('../services/api', () => ({
  login: (...a: unknown[]) => api.login(...a),
  logout: (...a: unknown[]) => api.logout(...a),
  verifyMfa: (...a: unknown[]) => api.verifyMfa(...a),
}));

const auth = {
  clearAuthData: vi.fn(),
  storeToken: vi.fn(),
  storeUser: vi.fn(),
};
vi.mock('../services/auth', () => ({
  clearAuthData: (...a: unknown[]) => auth.clearAuthData(...a),
  storeToken: (...a: unknown[]) => auth.storeToken(...a),
  storeUser: (...a: unknown[]) => auth.storeUser(...a),
}));

const appLock = { markAppLockUnlocked: vi.fn() };
vi.mock('../services/appLockStore', () => ({
  markAppLockUnlocked: (...a: unknown[]) => appLock.markAppLockUnlocked(...a),
}));

const sentry = { captureException: vi.fn() };
vi.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => sentry.captureException(...a),
}));

import authReducer, {
  loginAsync,
  logoutAsync,
  verifyMfaAsync,
  logout,
  setApproverRegistration,
  setCredentials,
  clearAuthenticatorRegisterGrant,
} from './authSlice';
import type { User } from '../services/api';

function makeStore() {
  return configureStore({ reducer: { auth: authReducer } });
}

const fakeUser: User = {
  id: 'user-1',
  email: 'tech@example.com',
  name: 'Tech Nician',
  role: 'technician',
};

beforeEach(() => {
  api.logout.mockReset().mockResolvedValue(undefined);
  api.login.mockReset();
  api.verifyMfa.mockReset();
  auth.clearAuthData.mockReset().mockResolvedValue(undefined);
  auth.storeToken.mockReset().mockResolvedValue(undefined);
  auth.storeUser.mockReset().mockResolvedValue(undefined);
  appLock.markAppLockUnlocked.mockReset().mockResolvedValue(undefined);
  sentry.captureException.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('interactive sign-in stamps the app lock as unlocked', () => {
  // navigation/AppLockGate.tsx runs its cold-launch check the first time a
  // process sees a token, and cannot tell one restored from the keychain from
  // one just earned with a password. Without this stamp the gate would throw a
  // Face ID prompt at the user a moment after they finished typing it.
  it('loginAsync marks unlocked once the token is stored', async () => {
    api.login.mockResolvedValue({ kind: 'ok', token: 'tok-1', user: fakeUser });
    const store = makeStore();

    const result = await store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));

    expect(result.type).toBe('auth/login/fulfilled');
    expect(appLock.markAppLockUnlocked).toHaveBeenCalledTimes(1);
    expect(auth.storeToken).toHaveBeenCalledWith('tok-1');
  });

  it('stamps only after the credentials are fully persisted', async () => {
    // storeUser throws on failure, so a login the user was told failed must not
    // leave an "unlocked" stamp behind. Ordering, not just presence.
    api.login.mockResolvedValue({ kind: 'ok', token: 'tok-1', user: fakeUser });
    const store = makeStore();

    await store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));

    const order = [
      auth.storeToken.mock.invocationCallOrder[0],
      auth.storeUser.mock.invocationCallOrder[0],
      appLock.markAppLockUnlocked.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('does NOT stamp when persisting the user fails', async () => {
    api.login.mockResolvedValue({ kind: 'ok', token: 'tok-1', user: fakeUser });
    auth.storeUser.mockRejectedValue(new Error('keychain locked'));
    const store = makeStore();

    const result = await store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));

    expect(result.type).toBe('auth/login/rejected');
    expect(appLock.markAppLockUnlocked).not.toHaveBeenCalled();
  });

  it('a failed stamp does not fail the login', async () => {
    // writeAppLockState swallows, so this cannot happen today — pin it, because
    // a throw here would reject a login whose token is already in the keychain.
    // The cost of a silently missed stamp is one spurious Face ID prompt.
    api.login.mockResolvedValue({ kind: 'ok', token: 'tok-1', user: fakeUser });
    appLock.markAppLockUnlocked.mockRejectedValue(new Error('keychain locked'));
    const store = makeStore();

    const result = await store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));

    expect(result.type).toBe('auth/login/fulfilled');
  });

  it('loginAsync does NOT mark unlocked when MFA is still outstanding', async () => {
    // The user has not authenticated yet — stamping here would leave the app
    // unlocked on the strength of a password alone.
    api.login.mockResolvedValue({ kind: 'mfaRequired', challenge: { tempToken: 'tmp' } });
    const store = makeStore();

    await store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));

    expect(appLock.markAppLockUnlocked).not.toHaveBeenCalled();
  });

  it('loginAsync stores enrollment handoff without credentials or an unlock stamp', async () => {
    api.login.mockResolvedValue({
      kind: 'mfaEnrollmentRequired',
      handoff: { reason: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' },
    });
    const store = makeStore();

    const result = await store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));

    expect(result.type).toBe('auth/login/fulfilled');
    expect(store.getState().auth).toMatchObject({
      token: null,
      user: null,
      mfaChallenge: null,
      mfaEnrollmentRequired: {
        reason: 'mfa_enrollment_required',
        enrollUrl: '/auth/mfa/setup',
      },
    });
    expect(auth.storeToken).not.toHaveBeenCalled();
    expect(auth.storeUser).not.toHaveBeenCalled();
    expect(appLock.markAppLockUnlocked).not.toHaveBeenCalled();
  });

  it('loginAsync does NOT mark unlocked when the API rejects', async () => {
    api.login.mockRejectedValue({ message: 'bad credentials' });
    const store = makeStore();

    await store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));

    expect(appLock.markAppLockUnlocked).not.toHaveBeenCalled();
  });

  it('verifyMfaAsync marks unlocked once the token is stored', async () => {
    api.verifyMfa.mockResolvedValue({ token: 'tok-2', user: fakeUser });
    const store = makeStore();

    const result = await store.dispatch(verifyMfaAsync({ code: '123456', tempToken: 'tmp', method: 'totp' }));

    expect(result.type).toBe('auth/verifyMfa/fulfilled');
    expect(api.verifyMfa).toHaveBeenCalledWith('123456', 'tmp', 'totp');
    expect(appLock.markAppLockUnlocked).toHaveBeenCalledTimes(1);
    expect(auth.storeToken).toHaveBeenCalledWith('tok-2');
  });

  it('verifyMfaAsync does NOT mark unlocked when the code is wrong', async () => {
    api.verifyMfa.mockRejectedValue({ message: 'invalid code' });
    const store = makeStore();

    await store.dispatch(verifyMfaAsync({ code: '000000', tempToken: 'tmp', method: 'totp' }));

    expect(appLock.markAppLockUnlocked).not.toHaveBeenCalled();
  });
});

describe('logoutAsync', () => {
  it('enqueues the local secure wipe before a delayed network logout completes', async () => {
    let releaseLogout!: () => void;
    api.logout.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseLogout = resolve; }));
    const store = makeStore();

    const logoutRequest = store.dispatch(logoutAsync());
    await vi.waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));

    expect(auth.clearAuthData).toHaveBeenCalledTimes(1);
    releaseLogout();
    await logoutRequest;
  });

  it('sync logout advances generation and fences an in-flight login before persistence', async () => {
    let releaseLogin!: (value: unknown) => void;
    api.login.mockImplementation(() => new Promise((resolve) => { releaseLogin = resolve; }));
    const store = makeStore();
    const staleLogin = store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));
    await vi.waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));

    store.dispatch(logout());
    releaseLogin({ kind: 'success', token: 'stale-token', user: fakeUser, registerGrant: null });
    await staleLogin;

    expect(auth.storeToken).not.toHaveBeenCalled();
    expect(auth.clearAuthData).toHaveBeenCalledTimes(1);
  });

  it('serializes slow A persistence, logout wipe, then replacement B persistence', async () => {
    const events: string[] = [];
    let releaseAStore!: () => void;
    let markAStoreStarted!: () => void;
    const aStoreStarted = new Promise<void>((resolve) => { markAStoreStarted = resolve; });
    const aStoreRelease = new Promise<void>((resolve) => { releaseAStore = resolve; });
    auth.storeToken.mockImplementation(async (token: string) => {
      if (token === 'token-a') {
        events.push('a:start');
        markAStoreStarted();
        await aStoreRelease;
        events.push('a:end');
      } else {
        events.push('b:token');
      }
    });
    auth.clearAuthData.mockImplementation(async () => { events.push('wipe'); });
    api.login.mockImplementation(async (email: string) => ({
      kind: 'success',
      token: email.startsWith('a@') ? 'token-a' : 'token-b',
      user: { ...fakeUser, email },
      registerGrant: null,
    }));
    const store = makeStore();

    const loginA = store.dispatch(loginAsync({ email: 'a@example.test', password: 'pw' }));
    await aStoreStarted;
    const logoutRequest = store.dispatch(logoutAsync());
    await vi.waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    const loginB = store.dispatch(loginAsync({ email: 'b@example.test', password: 'pw' }));
    releaseAStore();
    await Promise.all([loginA, logoutRequest, loginB]);

    expect(events).toEqual(['a:start', 'a:end', 'wipe', 'b:token']);
    expect(store.getState().auth.token).toBe('token-b');
    expect(store.getState().auth.user?.email).toBe('b@example.test');
  });

  it('advances the session generation before network logout and fences a delayed login write', async () => {
    let releaseLogin!: (value: unknown) => void;
    api.login.mockImplementation(() => new Promise((resolve) => { releaseLogin = resolve; }));
    const store = makeStore();
    const staleLogin = store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));
    await vi.waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));

    await store.dispatch(logoutAsync());
    releaseLogin({ kind: 'success', token: 'stale-token', user: fakeUser, registerGrant: null });
    await staleLogin;

    expect(auth.storeToken).not.toHaveBeenCalled();
    expect(auth.storeUser).not.toHaveBeenCalled();
    expect(store.getState().auth.token).toBeNull();
    expect(store.getState().auth.user).toBeNull();
  });

  it('fences delayed MFA credential persistence after logout', async () => {
    let releaseMfa!: (value: unknown) => void;
    api.verifyMfa.mockImplementation(() => new Promise((resolve) => { releaseMfa = resolve; }));
    const store = makeStore();
    const staleMfa = store.dispatch(verifyMfaAsync({ code: '123456', tempToken: 'temp-old', method: 'totp' }));
    await vi.waitFor(() => expect(api.verifyMfa).toHaveBeenCalledTimes(1));

    await store.dispatch(logoutAsync());
    releaseMfa({ token: 'stale-token', user: fakeUser, registerGrant: null });
    await staleMfa;

    expect(auth.storeToken).not.toHaveBeenCalled();
    expect(auth.storeUser).not.toHaveBeenCalled();
    expect(store.getState().auth.token).toBeNull();
  });

  it('fences a delayed enrollment handoff after logout', async () => {
    let releaseLogin!: (value: unknown) => void;
    api.login.mockImplementation(() => new Promise((resolve) => { releaseLogin = resolve; }));
    const store = makeStore();
    const staleLogin = store.dispatch(loginAsync({ email: fakeUser.email, password: 'pw' }));
    await vi.waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));

    await store.dispatch(logoutAsync());
    releaseLogin({
      kind: 'mfaEnrollmentRequired',
      handoff: { reason: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' },
    });
    await staleLogin;

    expect(store.getState().auth.mfaEnrollmentRequired).toBeNull();
    expect(store.getState().auth.token).toBeNull();
    expect(store.getState().auth.user).toBeNull();
  });

  it('API ok + wipe ok → fulfilled, wipe runs exactly once', async () => {
    const store = makeStore();
    const result = await store.dispatch(logoutAsync());

    expect(result.type).toBe('auth/logout/fulfilled');
    expect(auth.clearAuthData).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(store.getState().auth.token).toBeNull();
    expect(store.getState().auth.user).toBeNull();
  });

  it('API fails + wipe ok → rejected with the api message, still signs out', async () => {
    api.logout.mockRejectedValue(new Error('network down'));
    const store = makeStore();

    const result = await store.dispatch(logoutAsync());

    expect(result.type).toBe('auth/logout/rejected');
    expect(result.payload).toBe('network down');
    // wipe still runs exactly once even though the server logout failed
    expect(auth.clearAuthData).toHaveBeenCalledTimes(1);
    // api failure is reported to telemetry
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    // session is reset regardless
    expect(store.getState().auth.token).toBeNull();
  });

  it('API ok + wipe fails → rejected with the wipe message', async () => {
    auth.clearAuthData.mockRejectedValue(new Error('Secure wipe failed: x'));
    const store = makeStore();

    const result = await store.dispatch(logoutAsync());

    expect(result.type).toBe('auth/logout/rejected');
    expect(result.payload).toBe('Secure wipe failed: x');
    expect(auth.clearAuthData).toHaveBeenCalledTimes(1);
    expect(store.getState().auth.user).toBeNull();
  });

  it('API fails + wipe fails → rejected with both messages merged', async () => {
    api.logout.mockRejectedValue(new Error('network down'));
    auth.clearAuthData.mockRejectedValue(new Error('Secure wipe failed: x'));
    const store = makeStore();

    const result = await store.dispatch(logoutAsync());

    expect(result.type).toBe('auth/logout/rejected');
    expect(result.payload).toBe('network down; Secure wipe failed: x');
    expect(auth.clearAuthData).toHaveBeenCalledTimes(1);
    expect(store.getState().auth.token).toBeNull();
  });
});

describe('approver registration status', () => {
  it('records a failed registration so the UI can warn', () => {
    const store = makeStore();

    store.dispatch(setApproverRegistration({ status: 'failed', reason: 'http_400' }));

    expect(store.getState().auth.approverRegistration).toBe('failed');
    expect(store.getState().auth.approverRegistrationReason).toBe('http_400');
  });

  it('defaults the reason to null when omitted', () => {
    const store = makeStore();

    store.dispatch(setApproverRegistration({ status: 'registered' }));

    expect(store.getState().auth.approverRegistration).toBe('registered');
    expect(store.getState().auth.approverRegistrationReason).toBeNull();
  });

  it('starts idle so a fresh install shows no banner', () => {
    expect(makeStore().getState().auth.approverRegistration).toBe('idle');
  });

  it('clears on the synchronous logout reducer', () => {
    const store = makeStore();
    store.dispatch(setApproverRegistration({ status: 'failed', reason: 'http_400' }));

    store.dispatch(logout());

    expect(store.getState().auth.approverRegistration).toBe('idle');
    expect(store.getState().auth.approverRegistrationReason).toBeNull();
  });

  // The Sign Out button and the device_blocked listener both dispatch
  // logoutAsync, NOT the sync logout reducer — so these are the paths that
  // actually run in production. The root-level withLogoutReset in resettable.ts
  // would also blank the slice, but that safety net lives in another module:
  // asserting it here keeps the guarantee true of authSlice on its own.
  it.each([
    ['fulfilled', () => logoutAsync.fulfilled(undefined, 'req-id', { deliberate: true })],
    ['rejected', () => logoutAsync.rejected(null, 'req-id', { deliberate: true })],
  ])('clears on logoutAsync.%s — the next user must not inherit the banner or grant', (_name, action) => {
    const store = makeStore();
    store.dispatch(setApproverRegistration({ status: 'failed', reason: 'http_400' }));
    // Seed a live grant via loginAsync.fulfilled so we can prove logoutAsync
    // clears it too — not just the synchronous `logout()` reducer.
    store.dispatch(
      loginAsync.fulfilled(
        { token: 't', user: fakeUser, registerGrant: 'grant-1' } as any,
        '',
        { email: 'e', password: 'p' },
      ),
    );
    expect(store.getState().auth.authenticatorRegisterGrantId).toBe('grant-1');

    store.dispatch(action() as never);

    expect(store.getState().auth.approverRegistration).toBe('idle');
    expect(store.getState().auth.approverRegistrationReason).toBeNull();
    expect(store.getState().auth.authenticatorRegisterGrantId).toBeNull();
  });
});

describe('authenticatorRegisterGrantId (#2707)', () => {
  it('loginAsync.fulfilled stores the register grant; clearAuthenticatorRegisterGrant drops it', () => {
    let state = authReducer(undefined, loginAsync.fulfilled(
      { token: 't', user: fakeUser, registerGrant: 'grant-1' } as any, '', { email: 'e', password: 'p' }
    ));
    expect(state.authenticatorRegisterGrantId).toBe('grant-1');
    state = authReducer(state, clearAuthenticatorRegisterGrant());
    expect(state.authenticatorRegisterGrantId).toBeNull();
  });

  it('verifyMfaAsync.fulfilled stores the grant; logout clears it', () => {
    let state = authReducer(undefined, verifyMfaAsync.fulfilled(
      { token: 't', user: fakeUser, registerGrant: 'grant-2' } as any, '', { code: '123456', tempToken: 'tmp', method: 'totp' }
    ));
    expect(state.authenticatorRegisterGrantId).toBe('grant-2');
    state = authReducer(state, logout());
    expect(state.authenticatorRegisterGrantId).toBeNull();
  });

  it('setCredentials (cold-start restore) does NOT set a grant', () => {
    const state = authReducer(undefined, setCredentials({ token: 't', user: fakeUser }));
    expect(state.authenticatorRegisterGrantId).toBeNull();
  });
});
