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

import authReducer, { logoutAsync, logout, setApproverRegistration } from './authSlice';

function makeStore() {
  return configureStore({ reducer: { auth: authReducer } });
}

beforeEach(() => {
  api.logout.mockReset().mockResolvedValue(undefined);
  auth.clearAuthData.mockReset().mockResolvedValue(undefined);
  sentry.captureException.mockReset();
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

  it('clears on logout — the next user must not inherit the previous banner', () => {
    const store = makeStore();
    store.dispatch(setApproverRegistration({ status: 'failed', reason: 'http_400' }));

    store.dispatch(logout());

    expect(store.getState().auth.approverRegistration).toBe('idle');
    expect(store.getState().auth.approverRegistrationReason).toBeNull();
  });
});
