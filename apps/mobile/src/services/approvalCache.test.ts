import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_CACHE_KEY,
  clearApprovalCache,
  clearApprovalCacheOrThrow,
} from './approvalCache';

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

describe('clearApprovalCacheOrThrow', () => {
  it('deletes the approvals cache key', async () => {
    await clearApprovalCacheOrThrow();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(APPROVAL_CACHE_KEY);
  });

  it('propagates SecureStore errors (used on the security-teardown path)', async () => {
    secureStore.deleteItemAsync.mockRejectedValue(new Error('keychain locked'));
    await expect(clearApprovalCacheOrThrow()).rejects.toThrow('keychain locked');
  });
});

describe('clearApprovalCache (best-effort variant)', () => {
  it('swallows SecureStore errors for graceful-degradation callers', async () => {
    secureStore.deleteItemAsync.mockRejectedValue(new Error('keychain locked'));
    await expect(clearApprovalCache()).resolves.toBeUndefined();
  });
});
