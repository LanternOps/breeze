import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisGet, redisSet, redisRef } = vi.hoisted(() => {
  const redisGet = vi.fn(async (_key: string): Promise<string | null> => null);
  const redisSet = vi.fn(async (_k: string, _v: string, _ex: string, _ttl: number) => 'OK');
  return { redisGet, redisSet, redisRef: { value: { get: redisGet, set: redisSet } as unknown } };
});
vi.mock('../redis', () => ({ getRedis: () => redisRef.value }));

import { readProviderKeyProbe, recordProviderKeyProbe } from './keyProbe';

beforeEach(() => {
  vi.clearAllMocks();
  redisRef.value = { get: redisGet, set: redisSet };
});

describe('recordProviderKeyProbe', () => {
  it('writes the verdict under a TTL', async () => {
    await recordProviderKeyProbe('send_only');
    expect(redisSet).toHaveBeenCalledWith(expect.any(String), 'send_only', 'EX', 25 * 60 * 60);
  });
});

describe('readProviderKeyProbe', () => {
  it.each([['ok'], ['send_only']])('returns a recognised verdict (%s)', async (verdict) => {
    redisGet.mockResolvedValue(verdict);
    await expect(readProviderKeyProbe()).resolves.toBe(verdict);
  });

  it('treats an unrecognised stored value as unknown', async () => {
    redisGet.mockResolvedValue('garbage');
    await expect(readProviderKeyProbe()).resolves.toBeNull();
  });

  it('returns null when Redis is not configured', async () => {
    redisRef.value = null;
    await expect(readProviderKeyProbe()).resolves.toBeNull();
  });

  // `null` is rendered to the partner as "unknown", which is indistinguishable
  // from "the worker has not run yet". A bare `catch { return null }` therefore
  // made a Redis outage that permanently hid the key verdict leave NO trace
  // anywhere — the one failure mode this probe exists to make visible.
  it('logs the error before degrading to unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    redisGet.mockRejectedValue(new Error('READONLY replica'));

    await expect(readProviderKeyProbe()).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('key probe'), expect.stringContaining('READONLY'));
    warn.mockRestore();
  });
});
