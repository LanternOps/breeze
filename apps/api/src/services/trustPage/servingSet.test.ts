import { describe, expect, it, vi, beforeEach } from 'vitest';
const redisMock = vi.hoisted(() => ({ client: null as null | Record<string, ReturnType<typeof vi.fn> | Set<string>> }));
vi.mock('../redis', () => ({ getRedis: () => redisMock.client }));
const afterCommit = vi.hoisted(() => [] as Array<() => unknown>);
const dbRows = vi.hoisted(() => ({ rows: [] as unknown[], slugRows: [] as unknown[] }));
vi.mock('../../db', () => {
  const where = () => Object.assign(Promise.resolve(dbRows.rows), { limit: async () => dbRows.slugRows });
  const join: Record<string, unknown> = { where };
  join.innerJoin = () => join;
  return {
    db: { select: () => ({ from: () => ({ ...join, where }) }) },
    runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runAfterDbContextCommit: (_label: string, work: () => unknown) => { afterCommit.push(work); },
  };
});
import { addServing, isServing, refreshServingForPartner, removeServing, rebuildServingSetFromDb, scheduleServingRefreshForPartner, replaceServingSet, trustServingMember, cacheSnapshotPayload, readCachedSnapshotPayload, TRUST_SERVING_SET_KEY, TRUST_SERVING_BUILT_KEY, TRUST_SERVING_SENTINEL } from './servingSet';

function fakeRedis() {
  const set = new Set<string>(); const kv = new Map<string, string>();
  const ops: Array<[string, ...unknown[]]> = [];
  const multi = () => {
    const chain = {
      sadd: vi.fn((...a: unknown[]) => { ops.push(['sadd', ...a]); return chain; }),
      rename: vi.fn((...a: unknown[]) => { ops.push(['rename', ...a]); return chain; }),
      srem: vi.fn((...a: unknown[]) => { ops.push(['srem', ...a]); return chain; }),
      set: vi.fn((...a: unknown[]) => { ops.push(['set', ...a]); return chain; }),
      exec: vi.fn(async () => ops.map(() => [null, 'OK'])),
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
    set: vi.fn(async (k: string, v: string) => { kv.set(k, v); return 'OK'; }),
    exists: vi.fn(async (k: string) => (kv.has(k) ? 1 : 0)),
    multi: vi.fn(multi),
    _set: set,
    _ops: ops,
  };
}
const r = () => redisMock.client as unknown as ReturnType<typeof fakeRedis>;

describe('serving set', () => {
  beforeEach(() => { redisMock.client = fakeRedis() as never; dbRows.rows = []; });
  // A full build writes the marker AND keeps the sentinel member in the set (replaceServingSet).
  const markBuilt = async () => { r()._set.add(TRUST_SERVING_SENTINEL); await r().set(TRUST_SERVING_BUILT_KEY, '1'); };
  it('builds members and round-trips add/is/remove', async () => {
    expect(trustServingMember('nw', 'acme')).toBe('nw/acme');
    expect(trustServingMember('nw', 'ACME')).toBe('nw/acme');
    expect(trustServingMember('nw')).toBe('nw');
    await addServing(['nw/acme']);
    expect(r().set).not.toHaveBeenCalled();
    expect(await isServing('nw/acme')).toBeNull(); // add alone never claims completeness
    await markBuilt();
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
    expect(r()._ops[0]?.slice(2)).toEqual([TRUST_SERVING_SENTINEL, 'a/b', 'a']);
    expect(r()._ops[1]).toEqual(['rename', r()._ops[0]?.[1], TRUST_SERVING_SET_KEY]);
    r()._ops.length = 0;
    await replaceServingSet([]);
    // I8: the sentinel is never removed, so a built set always exists; only eviction makes it vanish.
    expect(r()._ops.map((o) => o[0])).toEqual(['sadd', 'rename', 'set']);
    expect(r()._ops[0]?.slice(2)).toEqual([TRUST_SERVING_SENTINEL]);
  });
  it('replaceServingSet writes the built marker in the same MULTI', async () => {
    await replaceServingSet(['a']);
    expect(r()._ops.at(-1)).toEqual(['set', TRUST_SERVING_BUILT_KEY, '1']);
  });
  it('replaceServingSet warns when a queued command failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r().multi.mockImplementation((() => {
      const c: Record<string, unknown> = {};
      for (const m of ['sadd', 'rename', 'srem', 'set']) c[m] = () => c;
      c.exec = async () => [[null, 1], [new Error('WRONGTYPE'), null]];
      return c;
    }) as never);
    await replaceServingSet(['a']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failing commands'), expect.anything());
    warn.mockRestore();
  });
  it('isServing is null (fall through to live resolve) when the built marker is absent, false only when built and member absent', async () => {
    r()._set.add('nw/acme'); // member present but marker never written (Redis lost data / never built)
    expect(await isServing('nw/acme')).toBeNull();
    expect(await isServing('nw/zzz')).toBeNull();
    await markBuilt();
    expect(await isServing('nw/zzz')).toBe(false);
    expect(await isServing('nw/acme')).toBe(true);
  });
  it('I8: marker present but the set evicted → null (fall through), never "nothing is published"', async () => {
    await markBuilt();
    r()._set.clear(); // Redis evicted trust:serving; the marker survived
    expect(await isServing('nw/acme')).toBeNull();
    // A publish after the eviction recreates the set with ONE member and no sentinel: still not trustworthy.
    await addServing(['nw/new']);
    expect(await isServing('nw/other')).toBeNull();
    expect(await isServing('nw/new')).toBeNull();
  });
  it('I8: removing the last published member keeps the set (sentinel) → false, not null', async () => {
    await markBuilt();
    await addServing(['nw/acme']);
    await removeServing(['nw/acme']);
    expect(await isServing('nw/acme')).toBe(false);
    await refreshServingForPartner('p1');
    expect(r()._set.has(TRUST_SERVING_SENTINEL)).toBe(true);
  });
  it('rebuildServingSetFromDb builds partner-home and org members from one query and returns the count', async () => {
    dbRows.rows = [
      { partnerSlug: 'nw', orgSlug: 'Acme', isPartnerHome: true },
      { partnerSlug: 'nw', orgSlug: 'beta', isPartnerHome: false },
    ];
    expect(await rebuildServingSetFromDb()).toBe(3);
    expect(r()._ops[0]).toEqual(['sadd', expect.stringContaining('trust:serving:rebuild:'), TRUST_SERVING_SENTINEL, 'nw/acme', 'nw', 'nw/beta']);
    expect(r()._ops.at(-1)).toEqual(['set', TRUST_SERVING_BUILT_KEY, '1']);
  });
  it('refreshServingForPartner with no live pages removes that partner\'s stale members via the slug lookup', async () => {
    await addServing(['nw/old', 'nw', 'other/keep']);
    dbRows.rows = [];
    dbRows.slugRows = [{ slug: 'nw' }];
    await refreshServingForPartner('p1');
    expect([...r()._set]).toEqual(['other/keep']);
  });
  it('Ruling 26: scheduleServingRefreshForPartner defers the refresh to after COMMIT and swallows its failure', async () => {
    afterCommit.length = 0;
    await addServing(['nw/old', 'other/keep']);
    dbRows.rows = []; dbRows.slugRows = [{ slug: 'nw' }];
    scheduleServingRefreshForPartner('p1', 'test');
    expect([...r()._set].sort()).toEqual(['nw/old', 'other/keep']); // nothing ran inside the transaction
    expect(afterCommit).toHaveLength(1);
    await afterCommit[0]!();
    expect([...r()._set]).toEqual(['other/keep']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r().smembers.mockRejectedValueOnce(new Error('boom'));
    r().smembers.mockRejectedValueOnce(new Error('boom'));
    scheduleServingRefreshForPartner('p1', 'test');
    await expect(Promise.resolve(afterCommit[1]!())).resolves.toBeUndefined();
    warn.mockRestore();
  });
  it('caches a payload for an hour and reads it back', async () => {
    await cacheSnapshotPayload('s1', { schemaVersion: 1 } as never);
    expect(r().setex).toHaveBeenCalledWith('trust:snapshot:s1', 3600, expect.any(String));
    expect(await readCachedSnapshotPayload('s1')).toEqual({ schemaVersion: 1 });
    expect(await readCachedSnapshotPayload('nope')).toBeNull();
  });
});
