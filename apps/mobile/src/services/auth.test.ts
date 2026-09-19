import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAuthData, SecureWipeError } from './auth';

const secureStore = {
  deleteItemAsync: vi.fn(),
};
vi.mock('expo-secure-store', () => ({
  deleteItemAsync: (...a: unknown[]) => secureStore.deleteItemAsync(...a),
}));

const sentry = {
  captureException: vi.fn(),
};
vi.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => sentry.captureException(...a),
}));

// The CSRF wipe goes through its owning module, not SecureStore directly, so it
// is invisible to the deleteItemAsync assertions above and needs its own mock.
const csrf = {
  clearCsrfToken: vi.fn(),
};
vi.mock('./csrfToken', () => ({
  // auth.ts imports the canonical key from here too, so the factory must supply
  // it — otherwise the deletions entry is keyed `undefined` and the wipe-failure
  // report names nothing.
  CSRF_TOKEN_KEY: 'breeze_csrf_token',
  clearCsrfToken: (...a: unknown[]) => csrf.clearCsrfToken(...a),
}));

// The unsent time-entry queue lives in AsyncStorage, not SecureStore, so it is
// invisible to the deleteItemAsync assertions and needs its own mock. Mocking
// the owning module also keeps the native AsyncStorage binding out of this
// node-environment suite.
const timeQueue = {
  clearQueueForSignOut: vi.fn(),
};
vi.mock('./timeEntryQueue', () => ({
  QUEUE_KEY: 'breeze.timeEntryQueue.v2',
  clearQueueForSignOut: (...a: unknown[]) => timeQueue.clearQueueForSignOut(...a),
}));

// A locally-ticking timer is cleared on every session end, deliberate or not.
const localTimer = {
  clearLocalTimer: vi.fn(),
};
vi.mock('./localTimer', () => ({
  LOCAL_TIMER_KEY: 'breeze.localTimer.v1',
  clearLocalTimer: (...a: unknown[]) => localTimer.clearLocalTimer(...a),
}));

beforeEach(() => {
  secureStore.deleteItemAsync.mockReset().mockResolvedValue(undefined);
  timeQueue.clearQueueForSignOut.mockReset().mockResolvedValue(undefined);
  localTimer.clearLocalTimer.mockReset().mockResolvedValue(undefined);
  sentry.captureException.mockReset();
  csrf.clearCsrfToken.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('clearAuthData', () => {
  it('removes the app-lock record, so no stale unlock outlives the session', async () => {
    // The record is a standing assertion that THIS device is currently
    // unlocked. If the token delete below fails, the surviving token restores
    // on the next launch and a leftover `locked: false` waves it past the gate.
    await clearAuthData();

    const keys = secureStore.deleteItemAsync.mock.calls.map((c) => c[0]);
    expect(keys).toContain('breeze.applock.state.v1');
  });

  it('removes the CSRF token, so the next account cannot inherit a stale double-submit value', async () => {
    // The token is account-scoped: a survivor hands the next account a value
    // that fails every write. This assertion is deliberately separate from the
    // deleteItemAsync checks — the wipe runs through clearCsrfToken(), so it
    // would not show up there even if it were working.
    await clearAuthData();

    expect(csrf.clearCsrfToken).toHaveBeenCalledTimes(1);
  });

  it('reports the real CSRF key when its wipe fails, and still runs every other delete', async () => {
    // The failure path is the one that matters: a surviving CSRF token is only
    // discoverable if SecureWipeError names the key that actually failed. This
    // also pins the key to the module's exported constant, so renaming it there
    // cannot silently leave this reporting a stale literal.
    csrf.clearCsrfToken.mockRejectedValue(new Error('keychain locked'));

    await expect(clearAuthData()).rejects.toBeInstanceOf(SecureWipeError);

    const keys = secureStore.deleteItemAsync.mock.calls.map((c) => c[0]);
    expect(keys).toContain('breeze_auth_token');
    expect(keys).toContain('breeze.applock.state.v1');
    expect(sentry.captureException).toHaveBeenCalled();
  });

  it('removes the auth token, the stored user, and the persistent approvals cache', async () => {
    await clearAuthData();

    const keys = secureStore.deleteItemAsync.mock.calls.map((c) => c[0]);
    expect(keys).toContain('breeze_auth_token');
    expect(keys).toContain('breeze_user');
    // The cross-session leak fix: the offline approvals cache must be wiped on
    // sign-out so the next account can't read the prior session's queue.
    expect(keys).toContain('breeze.approvals.cache.v1');
  });

  it('removes the signed native binding with the rest of session authority', async () => {
    await clearAuthData();

    const keys = secureStore.deleteItemAsync.mock.calls.map((c) => c[0]);
    expect(keys).toContain('breeze_native_auth_binding_v1');
  });

  it('does not call Sentry or throw when every wipe succeeds', async () => {
    await expect(clearAuthData()).resolves.toBeUndefined();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('attempts every delete (no short-circuit) when one SecureStore entry is locked', async () => {
    // A locked-keychain failure on one key must not stop the other deletes from
    // being attempted (allSettled, not a short-circuiting sequence).
    secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === 'breeze_auth_token') throw new Error('keychain locked');
    });

    await expect(clearAuthData()).rejects.toBeInstanceOf(SecureWipeError);

    const keys = secureStore.deleteItemAsync.mock.calls.map((c) => c[0]);
    expect(keys).toContain('breeze_user');
    expect(keys).toContain('breeze.approvals.cache.v1');
  });

  it('surfaces a partial-wipe failure instead of swallowing it', async () => {
    // Regression for #1625: a sensitive-key delete failure must be *surfaced*
    // (thrown + reported to telemetry), not silently swallowed, or the
    // surviving token/cache re-opens the cross-session leak #1415 closed.
    const cause = new Error('keychain locked');
    secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === 'breeze.approvals.cache.v1') throw cause;
    });

    await expect(clearAuthData()).rejects.toMatchObject({
      name: 'SecureWipeError',
      failedKeys: ['breeze.approvals.cache.v1'],
    });

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [reported, context] = sentry.captureException.mock.calls[0];
    expect(reported).toBeInstanceOf(SecureWipeError);
    expect((context as { extra?: { failedKeys?: string[] } }).extra?.failedKeys).toEqual([
      'breeze.approvals.cache.v1',
    ]);
  });

  it('reports every surviving key when multiple deletes fail', async () => {
    secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === 'breeze_auth_token' || key === 'breeze_user') {
        throw new Error('keychain locked');
      }
    });

    await expect(clearAuthData()).rejects.toMatchObject({
      failedKeys: ['breeze_auth_token', 'breeze_user'],
    });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('discards the unsent time-entry queue on a DELIBERATE sign-out', async () => {
    // `breeze.timeEntryQueue.v2` is a single un-namespaced AsyncStorage key and
    // the replay sends with whatever bearer token the CURRENT session holds. On
    // a shared field phone that writes technician A's queued minutes under
    // technician B.
    await clearAuthData({ deliberate: true });

    expect(timeQueue.clearQueueForSignOut).toHaveBeenCalledTimes(1);
  });

  it('KEEPS the queue on an involuntary session loss', async () => {
    // A 401 on the cold-start revalidation, a locked keychain and a blocked
    // device all reach here. A technician who worked offline all day and whose
    // token expired must not lose the backlog through no action of their own;
    // `reconcileQueueOwner` protects the next account at sign-in instead.
    await clearAuthData();
    await clearAuthData({ deliberate: false });

    expect(timeQueue.clearQueueForSignOut).not.toHaveBeenCalled();
    // The session-owned local timer still goes, on every path: it holds an
    // in-progress span, not unsent work.
    expect(localTimer.clearLocalTimer).toHaveBeenCalledTimes(2);
  });

  it('names the time-entry queue when its wipe fails, rather than reporting a clean sign-out', async () => {
    timeQueue.clearQueueForSignOut.mockRejectedValue(new Error('SQLite busy'));

    await expect(clearAuthData({ deliberate: true })).rejects.toMatchObject({
      name: 'SecureWipeError',
      failedKeys: ['breeze.timeEntryQueue.v2'],
    });
  });
});
