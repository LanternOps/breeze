import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAuthData } from './auth';

const secureStore = {
  deleteItemAsync: vi.fn(),
};
vi.mock('expo-secure-store', () => ({
  deleteItemAsync: (...a: unknown[]) => secureStore.deleteItemAsync(...a),
}));

beforeEach(() => {
  secureStore.deleteItemAsync.mockReset().mockResolvedValue(undefined);
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

  it('attempts every delete (no short-circuit) when one SecureStore entry is locked', async () => {
    // A locked-keychain failure on one key must not stop the other deletes from
    // being attempted. The helpers swallow their own errors, so clearAuthData
    // resolves; the load-bearing assertion is that all three deletes were still
    // dispatched — i.e. nobody refactors this into a short-circuiting sequence.
    secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === 'breeze_auth_token') throw new Error('keychain locked');
    });

    await expect(clearAuthData()).resolves.toBeUndefined();

    const keys = secureStore.deleteItemAsync.mock.calls.map((c) => c[0]);
    expect(keys).toContain('breeze_user');
    expect(keys).toContain('breeze.approvals.cache.v1');
  });
});
