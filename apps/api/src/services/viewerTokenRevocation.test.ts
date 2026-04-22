import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock redis before importing the module under test
vi.mock('./redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from './redis';
import { revokeViewerJti, isViewerJtiRevoked } from './viewerTokenRevocation';

const mockGetRedis = vi.mocked(getRedis);

function makeRedisStore() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    _store: store,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('viewerTokenRevocation', () => {
  it('flags a jti as revoked after revokeViewerJti()', async () => {
    const fakeRedis = makeRedisStore();
    mockGetRedis.mockReturnValue(fakeRedis as any);

    expect(await isViewerJtiRevoked('jti-1')).toBe(false);
    await revokeViewerJti('jti-1');
    expect(await isViewerJtiRevoked('jti-1')).toBe(true);
  });

  it('revokeViewerJti is best-effort when redis is down (does not throw)', async () => {
    mockGetRedis.mockReturnValue(null);
    // Should not throw even when Redis is unavailable
    await expect(revokeViewerJti('jti-2')).resolves.toBeUndefined();
  });

  it('fails closed when redis is down', async () => {
    mockGetRedis.mockReturnValue(null);
    // When Redis is unavailable, treat token as revoked (fail closed)
    expect(await isViewerJtiRevoked('jti-x')).toBe(true);
  });

  it('returns false for an unknown jti when redis is available', async () => {
    const fakeRedis = makeRedisStore();
    mockGetRedis.mockReturnValue(fakeRedis as any);

    expect(await isViewerJtiRevoked('never-revoked')).toBe(false);
  });

  it('uses the correct redis key prefix', async () => {
    const fakeRedis = makeRedisStore();
    mockGetRedis.mockReturnValue(fakeRedis as any);

    await revokeViewerJti('test-jti');

    expect(fakeRedis.set).toHaveBeenCalledWith(
      'viewer-jti-revoked:test-jti',
      '1',
      'EX',
      expect.any(Number),
    );
  });
});
