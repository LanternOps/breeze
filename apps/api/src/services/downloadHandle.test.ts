import { describe, it, expect, beforeEach, vi } from 'vitest';
import { issueDownloadHandle, consumeDownloadHandle } from './downloadHandle';

const redisStore = new Map<string, string>();
vi.mock('./redis', () => ({
  getRedis: () => ({
    set: vi.fn(async (k: string, v: string, _mode: string, _ttl: string, _ex: number) => {
      redisStore.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    del: vi.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    // Atomic GETDEL used by consumeDownloadHandle (Redis 6.2+).
    getdel: vi.fn(async (k: string) => {
      const v = redisStore.get(k) ?? null;
      redisStore.delete(k);
      return v;
    }),
  }),
}));

beforeEach(() => redisStore.clear());

describe('downloadHandle', () => {
  it('issues an opaque handle and consumes it once', async () => {
    const handle = await issueDownloadHandle('raw-enrollment-key');
    expect(handle).toMatch(/^dlh_[a-f0-9]{32}$/);
    const token = await consumeDownloadHandle(handle);
    expect(token).toBe('raw-enrollment-key');
    const second = await consumeDownloadHandle(handle);
    expect(second).toBeNull();
  });

  it('returns null for an unknown handle', async () => {
    expect(await consumeDownloadHandle('dlh_00000000000000000000000000000000')).toBeNull();
  });
});
