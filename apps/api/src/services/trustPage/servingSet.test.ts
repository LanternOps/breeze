import { describe, expect, it, vi, beforeEach } from 'vitest';
const redisMock = vi.hoisted(() => ({ client: null as null | Record<string, ReturnType<typeof vi.fn> | Set<string>> }));
vi.mock('../redis', () => ({ getRedis: () => redisMock.client }));
const dbRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ where: async () => dbRows.rows }) }) }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
import { addServing, isServing, refreshServingForPartner, removeServing, replaceServingSet, trustServingMember, cacheSnapshotPayload, readCachedSnapshotPayload, TRUST_SERVING_SET_KEY } from './servingSet';

function fakeRedis() {
  const set = new Set<string>(); const kv = new Map<string, string>();
  const ops: Array<[string, ...unknown[]]> = [];
  const multi = () => {
    const chain = {
      sadd: vi.fn((...a: unknown[]) => { ops.push(['sadd', ...a]); return chain; }),
      rename: vi.fn((...a: unknown[]) => { ops.push(['rename', ...a]); return chain; }),
      srem: vi.fn((...a: unknown[]) => { ops.push(['srem', ...a]); return chain; }),
      exec: vi.fn(async () => []),
    };
    return chain;
  };
  return {
    sismember: vi.fn(async (_k: string, m: string) => (set.has(m) ? 1 : 0)),
    sadd: vi.fn(async (_k: string, ...m: string[]) => { m.forEach((x) => set.add(x)); return m.length; }),
    srem: vi.fn(async (_k: string, ...m: string[]) => { m.forEach((x) => set.delete(x)); return m.length; }),
    smembers: vi.fn(async () => [...set]),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => { kv.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    multi: vi.fn(multi),
    _set: set,
    _ops: ops,
  };
}
const r = () => redisMock.client as unknown as ReturnType<typeof fakeRedis>;

describe('serving set', () => {
  beforeEach(() => { redisMock.client = fakeRedis() as never; dbRows.rows = []; });
  it('builds members and round-trips add/is/remove', async () => {
    expect(trustServingMember('nw', 'acme')).toBe('nw/acme');
    expect(trustServingMember('nw', 'ACME')).toBe('nw/acme');
    expect(trustServingMember('nw')).toBe('nw');
    await addServing(['nw/acme']);
    expect(await isServing('nw/acme')).toBe(true);
    expect(await isServing('nw/other')).toBe(false);
    await removeServing(['nw/acme']);
    expect(await isServing('nw/acme')).toBe(false);
    expect(r().sadd).toHaveBeenCalledWith(TRUST_SERVING_SET_KEY, 'nw/acme');
  });
  it('returns null (not false) when Redis is unavailable', async () => {
    redisMock.client = null;
    expect(await isServing('nw/acme')).toBeNull();
    await expect(addServing(['x'])).resolves.toBeUndefined();
  });
  it('returns null and never throws when Redis errors', async () => {
    r().sismember.mockRejectedValue(new Error('boom'));
    r().sadd.mockRejectedValue(new Error('boom'));
    r().get.mockRejectedValue(new Error('boom'));
    r().multi.mockImplementation(() => { throw new Error('boom'); });
    expect(await isServing('a')).toBeNull();
    await expect(addServing(['a'])).resolves.toBeUndefined();
    await expect(replaceServingSet(['a'])).resolves.toBeUndefined();
    expect(await readCachedSnapshotPayload('s')).toBeNull();
  });
  it('refreshServingForPartner removes stale members for that partner and adds live ones', async () => {
    await addServing(['nw/old', 'nw', 'other/keep']);
    dbRows.rows = [{ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: true }];
    await refreshServingForPartner('p1');
    expect([...r()._set].sort()).toEqual(['nw', 'nw/acme', 'other/keep']);
  });
  it('replaceServingSet swaps via a temp key inside MULTI, with a sentinel for the empty set', async () => {
    await replaceServingSet(['a/b', 'a']);
    expect(r()._ops[0]?.[0]).toBe('sadd');
    expect(r()._ops[0]?.slice(2)).toEqual(['a/b', 'a']);
    expect(r()._ops[1]).toEqual(['rename', r()._ops[0]?.[1], TRUST_SERVING_SET_KEY]);
    r()._ops.length = 0;
    await replaceServingSet([]);
    expect(r()._ops.map((o) => o[0])).toEqual(['sadd', 'rename', 'srem']);
    expect(r()._ops[2]).toEqual(['srem', TRUST_SERVING_SET_KEY, '__empty__']);
  });
  it('caches a payload for an hour and reads it back', async () => {
    await cacheSnapshotPayload('s1', { schemaVersion: 1 } as never);
    expect(r().setex).toHaveBeenCalledWith('trust:snapshot:s1', 3600, expect.any(String));
    expect(await readCachedSnapshotPayload('s1')).toEqual({ schemaVersion: 1 });
    expect(await readCachedSnapshotPayload('nope')).toBeNull();
  });
});
