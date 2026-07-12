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

const sentry = { captureException: vi.fn() };
vi.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => sentry.captureException(...a),
}));

import authReducer, { loginAsync, logoutAsync } from './authSlice';
import { advanceSessionGeneration } from '../services/sessionGeneration';

function makeStore() {
  return configureStore({ reducer: { auth: authReducer } });
}

beforeEach(() => {
  api.logout.mockReset().mockResolvedValue(undefined);
  auth.clearAuthData.mockReset().mockResolvedValue(undefined);
  auth.storeToken.mockReset().mockResolvedValue(undefined);
  auth.storeUser.mockReset().mockResolvedValue(undefined);
  api.login.mockReset();
  api.verifyMfa.mockReset();
  sentry.captureException.mockReset();
});

describe('authenticated-session persistence boundary', () => {
  const userA = { id: 'a', email: 'a@example.com', name: 'A', role: 'admin' };
  const userB = { id: 'b', email: 'b@example.com', name: 'B', role: 'admin' };

  it('compensates and rejects when logout lands between token and user writes', async () => {
    let releaseToken!: () => void;
    auth.storeToken.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseToken = resolve; }));
    api.login.mockResolvedValueOnce({ kind: 'success', token: 'token-a', user: userA });
    const store = makeStore();

    const login = store.dispatch(loginAsync({ email: userA.email, password: 'password' }));
    while (auth.storeToken.mock.calls.length === 0) await Promise.resolve();
    releaseToken();
    // The secure token write has completed, but its awaiting continuation has
    // not yet reached the user write. Land logout in that exact gap.
    const logout = store.dispatch(logoutAsync());

    expect((await login).type).toBe('auth/login/rejected');
    await logout;
    expect(auth.storeUser).not.toHaveBeenCalledWith(userA);
    expect(auth.clearAuthData).toHaveBeenCalled();
    expect(store.getState().auth.user).toBeNull();
  });

  it('lets login B replace login A while A persistence is pending without A wiping B', async () => {
    let releaseTokenA!: () => void;
    auth.storeToken.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseTokenA = resolve; }));
    api.login
      .mockResolvedValueOnce({ kind: 'success', token: 'token-a', user: userA })
      .mockResolvedValueOnce({ kind: 'success', token: 'token-b', user: userB });
    const store = makeStore();

    const loginA = store.dispatch(loginAsync({ email: userA.email, password: 'password' }));
    while (auth.storeToken.mock.calls.length === 0) await Promise.resolve();
    const loginB = store.dispatch(loginAsync({ email: userB.email, password: 'password' }));
    releaseTokenA();

    expect((await loginA).type).toBe('auth/login/rejected');
    expect((await loginB).type).toBe('auth/login/fulfilled');
    expect(auth.storeToken).toHaveBeenLastCalledWith('token-b');
    expect(auth.storeUser).toHaveBeenLastCalledWith(userB);
    expect(store.getState().auth.user).toEqual(userB);
  });

  it('compensates when terminal reauthentication lands between token and user writes', async () => {
    let releaseToken!: () => void;
    auth.storeToken.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseToken = resolve; }));
    api.login.mockResolvedValueOnce({ kind: 'success', token: 'token-a', user: userA });
    const store = makeStore();

    const login = store.dispatch(loginAsync({ email: userA.email, password: 'password' }));
    while (auth.storeToken.mock.calls.length === 0) await Promise.resolve();
    releaseToken();
    advanceSessionGeneration();

    expect((await login).type).toBe('auth/login/rejected');
    expect(auth.storeUser).not.toHaveBeenCalledWith(userA);
    expect(auth.clearAuthData).toHaveBeenCalled();
  });
});
afterEach(() => vi.restoreAllMocks());

describe('logoutAsync', () => {
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
