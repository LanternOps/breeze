import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
}));
const getRedisMock = vi.hoisted(() => vi.fn());
vi.mock('../redis', () => ({ getRedis: () => getRedisMock() }));

import {
  clearReattachSourceMarker,
  extendReattachSourceMarker,
  hasReattachSourceMarker,
  reattachSourceMarkerKey,
  setReattachSourceMarker,
} from './sourceMarker';

const DEVICE = '00000000-0000-4000-8000-0000000000d1';
const INTENT = '00000000-0000-4000-8000-0000000000a1';

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock);
});

describe('the reattach source marker (#8318 §6.2, review finding 12)', () => {
  it('is keyed by device and holds the intent id until the intent expires', async () => {
    redisMock.set.mockResolvedValueOnce('OK');
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await expect(setReattachSourceMarker(DEVICE, INTENT, expiresAt)).resolves.toBe(true);
    const [key, value, px, ttl] = redisMock.set.mock.calls[0]!;
    expect(key).toBe(`reattach-intent:source:${DEVICE}`);
    expect(reattachSourceMarkerKey(DEVICE)).toBe(key);
    expect(value).toBe(INTENT);
    expect(px).toBe('PX');
    expect(ttl).toBeGreaterThan(59 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);
  });

  it('is not written for an intent that has already expired', async () => {
    await expect(setReattachSourceMarker(DEVICE, INTENT, new Date(Date.now() - 1))).resolves.toBe(false);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('extends and clears only while it still names the intent (token-guarded Lua)', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await expect(extendReattachSourceMarker(DEVICE, INTENT, expiresAt)).resolves.toBe(true);
    expect(redisMock.eval.mock.calls[0]!.slice(1)).toEqual([1, `reattach-intent:source:${DEVICE}`, INTENT, String(expiresAt.getTime())]);
    expect(redisMock.eval.mock.calls[0]![0]).toContain('PEXPIREAT');
    await expect(clearReattachSourceMarker(DEVICE, INTENT)).resolves.toBe(false);
    expect(redisMock.eval.mock.calls[1]![0]).toContain('DEL');
    expect(redisMock.eval.mock.calls[1]!.slice(1)).toEqual([1, `reattach-intent:source:${DEVICE}`, INTENT]);
  });

  it('reads present / absent', async () => {
    redisMock.get.mockResolvedValueOnce(INTENT).mockResolvedValueOnce(null);
    await expect(hasReattachSourceMarker(DEVICE)).resolves.toBe(true);
    await expect(hasReattachSourceMarker(DEVICE)).resolves.toBe(false);
  });

  it('never throws: no Redis, a throwing getRedis or a failing command reads "no marker" / false', async () => {
    getRedisMock.mockReturnValueOnce(null);
    await expect(hasReattachSourceMarker(DEVICE)).resolves.toBe(false);
    getRedisMock.mockImplementationOnce(() => { throw new Error('not initialised'); });
    await expect(hasReattachSourceMarker(DEVICE)).resolves.toBe(false);
    redisMock.get.mockRejectedValueOnce(new Error('boom'));
    await expect(hasReattachSourceMarker(DEVICE)).resolves.toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisMock.set.mockRejectedValueOnce(new Error('boom'));
    await expect(setReattachSourceMarker(DEVICE, INTENT, new Date(Date.now() + 60_000))).resolves.toBe(false);
    redisMock.eval.mockRejectedValueOnce(new Error('boom'));
    await expect(clearReattachSourceMarker(DEVICE, INTENT)).resolves.toBe(false);
    warn.mockRestore();
  });
});
