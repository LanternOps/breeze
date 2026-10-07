import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  inContext: false,
  deferred: [] as Array<() => unknown>,
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => dbState.inContext,
  // Inside a context the real helper defers until the transaction settles;
  // tests flush `deferred` to model the COMMIT.
  runAfterDbContextExit: (_label: string, work: () => unknown) => {
    if (dbState.inContext) dbState.deferred.push(work);
    else work();
  },
}));

import { HotPathTtlCache, __resetHotPathCachesForTests } from './hotPathCache';

const T0 = Date.parse('2026-10-07T12:00:00Z');

function makeCache(overrides: Partial<{ ttlMs: number; maxEntries: number }> = {}) {
  return new HotPathTtlCache<string, { v: string }>({
    name: 'test',
    ttlMs: overrides.ttlMs ?? 60_000,
    maxEntries: overrides.maxEntries ?? 100,
  });
}

describe('HotPathTtlCache (#8053)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    dbState.inContext = false;
    dbState.deferred = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a hit inside the TTL and reloads once it has elapsed', async () => {
    const cache = makeCache();
    const load = vi.fn()
      .mockResolvedValueOnce({ v: 'first' })
      .mockResolvedValueOnce({ v: 'second' });

    expect(await cache.getOrLoad('k', load)).toEqual({ v: 'first' });
    vi.setSystemTime(T0 + 59_999);
    expect(await cache.getOrLoad('k', load)).toEqual({ v: 'first' });
    expect(load).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 60_000);
    expect(await cache.getOrLoad('k', load)).toEqual({ v: 'second' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps keys apart: one key is never served for another', async () => {
    const cache = makeCache();
    await cache.getOrLoad('org-a', async () => ({ v: 'a' }));
    expect(await cache.getOrLoad('org-b', async () => ({ v: 'b' }))).toEqual({ v: 'b' });
    expect(await cache.getOrLoad('org-a', async () => ({ v: 'stale?' }))).toEqual({ v: 'a' });
  });

  it('invalidate(key) drops only that key; invalidate() drops everything', async () => {
    const cache = makeCache();
    await cache.getOrLoad('a', async () => ({ v: 'a1' }));
    await cache.getOrLoad('b', async () => ({ v: 'b1' }));

    cache.invalidate('a');
    expect(await cache.getOrLoad('a', async () => ({ v: 'a2' }))).toEqual({ v: 'a2' });
    expect(await cache.getOrLoad('b', async () => ({ v: 'b2' }))).toEqual({ v: 'b1' });

    cache.invalidate();
    expect(await cache.getOrLoad('b', async () => ({ v: 'b3' }))).toEqual({ v: 'b3' });
  });

  it('never caches a failed load', async () => {
    const cache = makeCache();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ v: 'ok' });

    await expect(cache.getOrLoad('k', load)).rejects.toThrow('db down');
    expect(await cache.getOrLoad('k', load)).toEqual({ v: 'ok' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('honours shouldCache: a declined value is returned but reloaded next time', async () => {
    const cache = new HotPathTtlCache<string, boolean>({ name: 'absence', ttlMs: 60_000, maxEntries: 10 });
    const load = vi.fn().mockResolvedValue(true);
    const onlyAbsence = { shouldCache: (present: boolean) => !present };

    expect(await cache.getOrLoad('d', load, onlyAbsence)).toBe(true);
    expect(await cache.getOrLoad('d', load, onlyAbsence)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not store a load that an invalidation raced', async () => {
    const cache = makeCache();
    let release!: (value: { v: string }) => void;
    const inFlight = cache.getOrLoad('k', () => new Promise((resolve) => { release = resolve; }));

    cache.invalidate('k'); // a writer commits while the read is in flight
    release({ v: 'pre-change' });
    expect(await inFlight).toEqual({ v: 'pre-change' }); // its own caller still gets it

    expect(await cache.getOrLoad('k', async () => ({ v: 'post-change' }))).toEqual({ v: 'post-change' });
  });

  it('invalidateAroundCommit drops again after the writer commits, beating a read of pre-commit rows', async () => {
    const cache = makeCache();
    await cache.getOrLoad('k', async () => ({ v: 'old' }));

    // The writer, inside its transaction, invalidates before COMMIT.
    dbState.inContext = true;
    cache.invalidateAroundCommit('k');
    dbState.inContext = false;

    // A concurrent reader (outside any context) re-reads before the COMMIT
    // lands and still sees the old row; it gets cached...
    expect(await cache.getOrLoad('k', async () => ({ v: 'old' }))).toEqual({ v: 'old' });

    // ...until the COMMIT settles and the deferred second drop runs.
    for (const work of dbState.deferred.splice(0)) work();
    expect(await cache.getOrLoad('k', async () => ({ v: 'new' }))).toEqual({ v: 'new' });
  });

  it('is bypassed entirely inside an ambient DB context (no read, no write)', async () => {
    const cache = makeCache();
    await cache.getOrLoad('k', async () => ({ v: 'top-level' }));

    dbState.inContext = true;
    // Not served from the cache: the caller's transaction (its RLS scope and
    // its uncommitted writes) must answer...
    expect(await cache.getOrLoad('k', async () => ({ v: 'in-tx' }))).toEqual({ v: 'in-tx' });
    dbState.inContext = false;

    // ...and that in-transaction read was not stored.
    expect(await cache.getOrLoad('k', async () => ({ v: 'unused' }))).toEqual({ v: 'top-level' });
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const cache = makeCache({ maxEntries: 2 });
    await cache.getOrLoad('a', async () => ({ v: 'a' }));
    await cache.getOrLoad('b', async () => ({ v: 'b' }));
    await cache.getOrLoad('c', async () => ({ v: 'c' }));

    expect(cache.size).toBe(2);
    expect(await cache.getOrLoad('a', async () => ({ v: 'a-reloaded' }))).toEqual({ v: 'a-reloaded' });
    expect(await cache.getOrLoad('c', async () => ({ v: 'unused' }))).toEqual({ v: 'c' });
  });

  it('rejects a non-positive TTL or size', () => {
    expect(() => new HotPathTtlCache({ name: 'bad', ttlMs: 0, maxEntries: 1 })).toThrow(/ttlMs/);
    expect(() => new HotPathTtlCache({ name: 'bad', ttlMs: 1, maxEntries: 0 })).toThrow(/maxEntries/);
  });

  it('__resetHotPathCachesForTests empties every registered cache', async () => {
    const a = makeCache();
    const b = makeCache();
    await a.getOrLoad('k', async () => ({ v: 'a' }));
    await b.getOrLoad('k', async () => ({ v: 'b' }));

    __resetHotPathCachesForTests();

    expect(a.size).toBe(0);
    expect(b.size).toBe(0);
  });
});
