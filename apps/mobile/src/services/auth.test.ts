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

beforeEach(() => {
  secureStore.deleteItemAsync.mockReset().mockResolvedValue(undefined);
  sentry.captureException.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('clearAuthData', () => {
  it('removes the auth token, the stored user, and the persistent approvals cache', async () => {
    await clearAuthData();

    const keys = secureStore.deleteItemAsync.mock.calls.map((c) => c[0]);
    expect(keys).toContain('breeze_auth_token');
    expect(keys).toContain('breeze_user');
    // The cross-session leak fix: the offline approvals cache must be wiped on
    // sign-out so the next account can't read the prior session's queue.
    expect(keys).toContain('breeze.approvals.cache.v1');
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
});
