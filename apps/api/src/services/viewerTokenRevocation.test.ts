import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock redis before importing the module under test
vi.mock('./redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from './redis';
import { VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS } from './jwt';
import { isViewerJtiRevoked, revokeViewerJti, revokeViewerSession } from './viewerTokenRevocation';

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

  it('fails closed when a revocation cannot be persisted', async () => {
    mockGetRedis.mockReturnValue(null);
    await expect(revokeViewerJti('jti-2')).rejects.toThrow(/unavailable/i);
    await expect(revokeViewerSession('session-2')).rejects.toThrow(/unavailable/i);
  });

  it('does not log raw viewer identifiers when redis is down', async () => {
    mockGetRedis.mockReturnValue(null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(revokeViewerJti('raw-viewer-jti')).rejects.toThrow();
    await expect(revokeViewerSession('raw-session-id')).rejects.toThrow();

    const logged = errorSpy.mock.calls.flatMap((call) => call.map((arg) => JSON.stringify(arg))).join('\n');
    expect(logged).not.toContain('raw-viewer-jti');
    expect(logged).not.toContain('raw-session-id');
    expect(logged).toContain('jtiFingerprint');
    expect(logged).toContain('sessionFingerprint');

    errorSpy.mockRestore();
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
      VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS,
    );
  });

  it('uses the signed viewer lifetime for session revocation too', async () => {
    const fakeRedis = makeRedisStore();
    mockGetRedis.mockReturnValue(fakeRedis as any);

    await revokeViewerSession('test-session');

    expect(fakeRedis.set).toHaveBeenCalledWith(
      'viewer-session-revoked:test-session',
      '1',
      'EX',
      VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS,
    );
  });
});
