import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  inContext: false,
  deferred: [] as Array<() => unknown>,
  scope: undefined as 'system' | 'organization' | 'partner' | undefined,
}));

vi.mock('../db', () => ({
  hasDbAccessContext: () => dbState.inContext,
  getCurrentDbAccessContext: () => (dbState.scope ? { scope: dbState.scope } : undefined),
  // Inside a context the real helper defers until the transaction settles;
  // tests flush `deferred` to model the COMMIT.
  runAfterDbContextExit: (_label: string, work: () => unknown) => {
    if (dbState.inContext) dbState.deferred.push(work);
    else work();
  },
}));

import { DeferredCacheFills, HotPathTtlCache, __resetHotPathCachesForTests } from './hotPathCache';

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
    dbState.scope = undefined;
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

describe('HotPathTtlCache deferred fills (#8053 W1a-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    dbState.inContext = false;
    dbState.scope = undefined;
  });
  afterEach(() => vi.useRealTimers());

  it('peek never loads and honours the TTL', async () => {
    const cache = makeCache({ ttlMs: 1_000 });
    expect(cache.peek('a')).toBeUndefined();
    await cache.getOrLoad('a', async () => ({ v: '1' }));
    expect(cache.peek('a')).toEqual({ v: '1' });
    vi.setSystemTime(T0 + 1_001);
    expect(cache.peek('a')).toBeUndefined();
  });

  it('fillIfCurrent stores only when no invalidate() ran since the ticket', () => {
    const cache = makeCache();
    const ticket = cache.ticket();
    cache.fillIfCurrent('a', { v: '1' }, ticket);
    expect(cache.peek('a')).toEqual({ v: '1' });

    const stale = cache.ticket();
    cache.invalidate('b');
    cache.fillIfCurrent('a', { v: '2' }, stale);
    expect(cache.peek('a')).toEqual({ v: '1' });
  });

  it('fillIfCurrent refuses to run inside a DB context (the load has not committed)', () => {
    const cache = makeCache();
    dbState.inContext = true;
    expect(() => cache.fillIfCurrent('a', { v: '1' }, cache.ticket())).toThrow(/inside a DB context/);
  });

  it('through: a hit never loads; a miss in a SYSTEM context loads now and stores only on flush', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.inContext = true;
    dbState.scope = 'system';
    const load = vi.fn(async () => ({ v: 'loaded' }));

    await expect(fills.through(cache, 'org-1', load)).resolves.toEqual({ v: 'loaded' });
    expect(cache.peek('org-1')).toBeUndefined();

    dbState.inContext = false;
    fills.flush();
    expect(cache.peek('org-1')).toEqual({ v: 'loaded' });

    dbState.inContext = true;
    await fills.through(cache, 'org-1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('through under an ORG-scoped context loads but never caches (a narrower RLS answer)', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.inContext = true;
    dbState.scope = 'organization';
    await fills.through(cache, 'org-1', async () => ({ v: 'partial' }));
    dbState.inContext = false;
    fills.flush();
    expect(cache.peek('org-1')).toBeUndefined();
  });

  it('through: a failed load queues nothing; an invalidate before flush wins', async () => {
    const cache = makeCache();
    const fills = new DeferredCacheFills();
    dbState.inContext = true;
    dbState.scope = 'system';
    await expect(fills.through(cache, 'org-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await fills.through(cache, 'org-2', async () => ({ v: 'pre-commit' }));
    cache.invalidate('org-2');
    dbState.inContext = false;
    fills.flush();
    expect(cache.peek('org-1')).toBeUndefined();
    expect(cache.peek('org-2')).toBeUndefined();
  });

  it('flush: a throwing fill does not drop the fills queued after it', async () => {
    dbState.inContext = true;
    dbState.scope = 'system';
    const bad = makeCache();
    const good = makeCache();
    const fills = new DeferredCacheFills();
    await fills.through(bad, 'org-1', async () => ({ v: 'bad' }));
    await fills.through(good, 'org-1', async () => ({ v: 'good' }));
    vi.spyOn(bad, 'fillIfCurrent').mockImplementation(() => { throw new Error('fill boom'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbState.inContext = false;
    expect(() => fills.flush()).not.toThrow();
    expect(good.peek('org-1')).toEqual({ v: 'good' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
