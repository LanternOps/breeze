import { describe, expect, it, vi, beforeEach } from 'vitest';
const redisMock = vi.hoisted(() => ({ client: null as null | Record<string, ReturnType<typeof vi.fn> | Set<string>> }));
vi.mock('../redis', () => ({ getRedis: () => redisMock.client }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../sentry', () => sentry);
const afterCommit = vi.hoisted(() => [] as Array<() => unknown>);
const dbRows = vi.hoisted(() => ({ rows: [] as unknown[], slugRows: [] as unknown[], reader: null as null | (() => Promise<unknown[]>), reads: 0, inContext: false }));
vi.mock('../../db', () => {
  // Lazy thenable: a live-rows read happens (and is counted) only when awaited; `.limit` is the slug lookup.
  const where = () => ({
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      dbRows.reads += 1;
      return (dbRows.reader ? dbRows.reader() : Promise.resolve(dbRows.rows)).then(res, rej);
    },
    limit: async () => dbRows.slugRows,
  });
  const join: Record<string, unknown> = { where };
  join.innerJoin = () => join;
  return {
    db: { select: () => ({ from: () => ({ ...join, where }) }) },
    runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
    hasDbAccessContext: () => dbRows.inContext,
    runAfterDbContextCommit: (_label: string, work: () => unknown) => { afterCommit.push(work); },
  };
});
import {
  applyServingSnapshot, isServing, readServingEpoch, scheduleServingSetRebuild, servingSetRebuildSettled, SNAPSHOT_APPLY_LUA,
  TRUST_SERVING_REBUILD_LOCK_KEY, TRUST_SERVING_EPOCH_KEY, refreshServingForPartner, rebuildServingSetFromDb, scheduleServingRefreshForPartner,
  trustServingMember, cacheSnapshotPayload, readCachedSnapshotPayload, TRUST_SERVING_SET_KEY, TRUST_SERVING_BUILT_KEY, TRUST_SERVING_SENTINEL,
} from './servingSet';

function fakeRedis() {
  const set = new Set<string>(); const kv = new Map<string, string>();
  return {
    sismember: vi.fn(async (_k: string, m: string) => (set.has(m) ? 1 : 0)),
    smembers: vi.fn(async () => [...set]),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => { kv.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...opts: unknown[]) => { if (opts.includes('NX') && kv.has(k)) return null; kv.set(k, v); return 'OK'; }),
    exists: vi.fn(async (k: string) => (kv.has(k) ? 1 : 0)),
    del: vi.fn(async (...k: string[]) => { let n = 0; k.forEach((x) => { if (kv.delete(x)) n += 1; }); return n; }),
    incr: vi.fn(async (k: string) => { const v = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(v)); return v; }),
    // JS emulation of SNAPSHOT_APPLY_LUA (the real script is proven by trustPageServingSet.integration.test.ts).
    // KEYS: epoch, set, built, tmp. ARGV: expected epoch ('' = absent), scope kind, mode, slug, sentinel, members…
    eval: vi.fn(async (script: string, _n: number, epochKey: string, _setKey: string, builtKey: string, _tmp: string,
      expected: string, kind: string, mode: string, slug: string, sentinel: string, ...members: string[]) => {
      if (script !== SNAPSHOT_APPLY_LUA) throw new Error('unexpected script');
      const cur = kv.get(epochKey) ?? '';
      if (mode !== 'merge' && cur !== expected) return 'conflict';
      if (kind === 'all') {
        const next = new Set<string>([sentinel, ...members]);
        if (mode === 'merge') set.forEach((m) => next.add(m));
        set.clear(); next.forEach((m) => set.add(m));
        kv.set(builtKey, '1');
      } else {
        if (mode !== 'merge' && slug) {
          for (const m of [...set]) if ((m === slug || m.startsWith(`${slug}/`)) && !members.includes(m)) set.delete(m);
        }
        members.forEach((m) => set.add(m));
      }
      kv.set(epochKey, String(Number(cur || 0) + 1));
      return 'applied';
    }),
    _set: set,
    _kv: kv,
  };
}
const r = () => redisMock.client as unknown as ReturnType<typeof fakeRedis>;
/** Full rebuilds are observable as `eval` calls whose scope argument is 'all'. */
const rebuilds = () => r().eval.mock.calls.filter((c) => c[7] === 'all').length;

describe('serving set', () => {
  // A self-heal scheduled by a previous test's null must finish against THAT test's Redis, not this one's.
  beforeEach(async () => {
    await servingSetRebuildSettled();
    redisMock.client = fakeRedis() as never;
    dbRows.rows = []; dbRows.slugRows = []; dbRows.reader = null; dbRows.reads = 0; dbRows.inContext = false;
  });
  // A full build writes the marker AND keeps the sentinel member in the set.
  const markBuilt = async () => { r()._set.add(TRUST_SERVING_SENTINEL); await r().set(TRUST_SERVING_BUILT_KEY, '1'); };
  it('builds members and round-trips a partner apply through isServing', async () => {
    expect(trustServingMember('nw', 'acme')).toBe('nw/acme');
    expect(trustServingMember('nw', 'ACME')).toBe('nw/acme');
    expect(trustServingMember('nw')).toBe('nw');
    expect(await applyServingSnapshot({ epoch: null, members: ['nw/acme'], scope: { kind: 'partner', slug: 'nw' } })).toBe('applied');
    expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(0);
    expect(await isServing('nw/acme')).toBeNull(); // a partner apply alone never claims completeness
    await markBuilt();
    expect(await isServing('nw/acme')).toBe(true);
    expect(await isServing('nw/other')).toBe(false);
    expect(await applyServingSnapshot({ epoch: await readServingEpoch(), members: [], scope: { kind: 'partner', slug: 'nw' } })).toBe('applied');
    expect(await isServing('nw/acme')).toBe(false);
  });
  it('a strict apply with a stale epoch writes nothing; every apply bumps the epoch', async () => {
    expect(await readServingEpoch()).toBeNull();
    await applyServingSnapshot({ epoch: null, members: ['nw/acme'], scope: { kind: 'partner', slug: 'nw' } });
    expect(await readServingEpoch()).toBe('1');
    expect(await applyServingSnapshot({ epoch: null, members: [], scope: { kind: 'all' } })).toBe('conflict');
    expect(r()._set.has('nw/acme')).toBe(true);
    expect(await readServingEpoch()).toBe('1');
    expect(r().eval).toHaveBeenCalledWith(SNAPSHOT_APPLY_LUA, 4, TRUST_SERVING_EPOCH_KEY, TRUST_SERVING_SET_KEY, TRUST_SERVING_BUILT_KEY,
      expect.stringContaining('trust:serving:rebuild:'), '', 'all', 'strict', '', TRUST_SERVING_SENTINEL); // '' = the stale "absent" epoch
  });
  it('returns null (not false) and writes nothing when Redis is unavailable', async () => {
    redisMock.client = null;
    expect(await isServing('nw/acme')).toBeNull();
    dbRows.rows = [{ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false }];
    await expect(refreshServingForPartner('p1')).resolves.toBe('no_redis');
    await expect(rebuildServingSetFromDb()).resolves.toBe(1); // the count is still reported (worker summary)
  });
  it('returns null and never throws when Redis errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r().sismember.mockRejectedValue(new Error('boom'));
    r().get.mockRejectedValue(new Error('boom'));
    expect(await isServing('a')).toBeNull();
    await expect(refreshServingForPartner('p1')).resolves.toBe('degraded');
    await expect(rebuildServingSetFromDb()).resolves.toBe(0);
    expect(await readCachedSnapshotPayload('s')).toBeNull();
    warn.mockRestore();
  });
  it('refreshServingForPartner removes stale members for that partner and adds live ones', async () => {
    r()._set.add('nw/old'); r()._set.add('nw'); r()._set.add('other/keep');
    dbRows.rows = [{ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: true }];
    await expect(refreshServingForPartner('p1')).resolves.toBe('applied');
    expect([...r()._set].sort()).toEqual(['nw', 'nw/acme', 'other/keep']);
    expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(0); // a partner apply never writes the marker
  });
  it('a full rebuild swaps in sentinel + members and writes the built marker', async () => {
    r()._set.add('gone/x');
    dbRows.rows = [{ partnerSlug: 'a', orgSlug: 'b', isPartnerHome: true }];
    await rebuildServingSetFromDb();
    expect([...r()._set].sort()).toEqual([TRUST_SERVING_SENTINEL, 'a', 'a/b'].sort());
    expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(1);
    // I8: the sentinel is never removed, so a built set always exists; only eviction makes it vanish.
    dbRows.rows = [];
    await rebuildServingSetFromDb();
    expect([...r()._set]).toEqual([TRUST_SERVING_SENTINEL]);
  });
  it('an unexpected script result is treated as a Redis failure (degraded), never as success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await markBuilt();
    r().eval.mockResolvedValueOnce('OK' as never); // a script that answered something other than applied/conflict
    dbRows.rows = [{ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false }];
    await expect(refreshServingForPartner('p1')).resolves.toBe('degraded');
    expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(0);
    warn.mockRestore();
  });
  it('a DB error propagates (the caller decides), and leaves Redis untouched', async () => {
    dbRows.reader = async () => { throw new Error('db down'); };
    await expect(refreshServingForPartner('p1')).rejects.toThrow('db down');
    expect(r().eval).not.toHaveBeenCalled();
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
    dbRows.rows = [{ partnerSlug: 'nw', orgSlug: 'new', isPartnerHome: false }];
    await refreshServingForPartner('p1');
    expect(await isServing('nw/other')).toBeNull();
    expect(await isServing('nw/new')).toBeNull();
  });
  it('I8: removing the last published member keeps the set (sentinel) → false, not null', async () => {
    await markBuilt();
    r()._set.add('nw/acme');
    dbRows.slugRows = [{ slug: 'nw' }];
    await refreshServingForPartner('p1');
    expect(await isServing('nw/acme')).toBe(false);
    expect(r()._set.has(TRUST_SERVING_SENTINEL)).toBe(true);
  });
  it('rebuildServingSetFromDb builds partner-home and org members from one query and returns the count', async () => {
    dbRows.rows = [
      { partnerSlug: 'nw', orgSlug: 'Acme', isPartnerHome: true },
      { partnerSlug: 'nw', orgSlug: 'beta', isPartnerHome: false },
    ];
    expect(await rebuildServingSetFromDb()).toBe(3);
    expect(dbRows.reads).toBe(1);
    expect(r().eval.mock.calls[0]?.slice(6)).toEqual(['', 'all', 'strict', '', TRUST_SERVING_SENTINEL, 'nw/acme', 'nw', 'nw/beta']);
    expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(1);
  });
  it('refreshServingForPartner with no live pages removes that partner\'s stale members via the slug lookup', async () => {
    r()._set.add('nw/old'); r()._set.add('nw'); r()._set.add('other/keep');
    dbRows.rows = [];
    dbRows.slugRows = [{ slug: 'nw' }];
    await refreshServingForPartner('p1');
    expect([...r()._set]).toEqual(['other/keep']);
  });
  it('an unknown partner (no slug) writes nothing', async () => {
    r()._set.add('nw/old');
    await expect(refreshServingForPartner('p-gone')).resolves.toBe('applied');
    expect(r().eval).not.toHaveBeenCalled();
    expect([...r()._set]).toEqual(['nw/old']);
  });
  it('Ruling 26: scheduleServingRefreshForPartner defers the refresh to after COMMIT and swallows its failure', async () => {
    afterCommit.length = 0;
    r()._set.add('nw/old'); r()._set.add('other/keep');
    dbRows.rows = []; dbRows.slugRows = [{ slug: 'nw' }];
    scheduleServingRefreshForPartner('p1', 'test');
    expect([...r()._set].sort()).toEqual(['nw/old', 'other/keep']); // nothing ran inside the transaction
    expect(afterCommit).toHaveLength(1);
    await afterCommit[0]!();
    expect([...r()._set]).toEqual(['other/keep']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbRows.reader = async () => { throw new Error('db down'); };
    scheduleServingRefreshForPartner('p1', 'test');
    await expect(Promise.resolve(afterCommit[1]!())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping the built marker'), expect.objectContaining({ reason: 'test' }), expect.any(Error));
    warn.mockRestore();
  });
  describe('self-heal: scheduleServingSetRebuild', () => {
    it('two nulls in one tick (marker missing) schedule exactly one rebuild, under the cluster lock', async () => {
      dbRows.rows = [{ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false }];
      expect(await isServing('nw/acme')).toBeNull();
      expect(await isServing('nw/beta')).toBeNull();
      await servingSetRebuildSettled();
      expect(rebuilds()).toBe(1);
      // Single-flight in process: the second null never even tries the cluster lock.
      const lockAttempts = () => r().set.mock.calls.filter((c) => c[0] === TRUST_SERVING_REBUILD_LOCK_KEY).length;
      expect(lockAttempts()).toBe(1);
      expect(r().set).toHaveBeenCalledWith(TRUST_SERVING_REBUILD_LOCK_KEY, '1', 'EX', 60, 'NX');
      // The lock is held after success (it is the per-minute rate limit): a later null in the same minute
      // tries the lock again but runs no second rebuild query.
      r().exists.mockResolvedValueOnce(0);
      expect(await isServing('nw/acme')).toBeNull();
      await servingSetRebuildSettled();
      expect(lockAttempts()).toBe(2);
      expect(rebuilds()).toBe(1);
      // The rebuild is the full one: sentinel + every live member, then the built marker.
      expect([...r()._set].sort()).toEqual([TRUST_SERVING_SENTINEL, 'nw/acme'].sort());
      expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(1);
    });
    it('a null because the sentinel was evicted also schedules the rebuild', async () => {
      await markBuilt();
      r()._set.clear();
      expect(await isServing('nw/acme')).toBeNull();
      await servingSetRebuildSettled();
      expect(rebuilds()).toBe(1);
    });
    it('does not rebuild when another instance holds the lock', async () => {
      await r().set(TRUST_SERVING_REBUILD_LOCK_KEY, '1');
      expect(await isServing('nw/acme')).toBeNull();
      await servingSetRebuildSettled();
      expect(rebuilds()).toBe(0);
    });
    it('a Redis error returns null and schedules no rebuild', async () => {
      r().sismember.mockRejectedValue(new Error('boom'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await isServing('nw/acme')).toBeNull();
      await servingSetRebuildSettled();
      expect(r().set).not.toHaveBeenCalled();
      expect(rebuilds()).toBe(0);
      warn.mockRestore();
    });
    it('a known-built answer (true/false) schedules nothing', async () => {
      await markBuilt();
      expect(await isServing('nw/zzz')).toBe(false);
      await servingSetRebuildSettled();
      expect(r().set).toHaveBeenCalledTimes(1); // markBuilt only
    });
    it('a lock-acquisition failure is logged, reported and swallowed; a later null can try again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sentry.captureException.mockClear();
      r().set.mockRejectedValueOnce(new Error('lock boom'));
      scheduleServingSetRebuild('test');
      await expect(servingSetRebuildSettled()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('self-heal'), expect.objectContaining({ reason: 'test' }), expect.any(Error));
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(rebuilds()).toBe(0);
      scheduleServingSetRebuild('test-again');
      await servingSetRebuildSettled();
      expect(rebuilds()).toBe(1);
      warn.mockRestore();
    });
    it('a DB failure after the lock is held is swallowed and reported, and the lock stays held', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sentry.captureException.mockClear();
      dbRows.reader = async () => { throw new Error('db down'); };
      scheduleServingSetRebuild('db-fails');
      await expect(servingSetRebuildSettled()).resolves.toBeUndefined();
      expect(sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), undefined, { component: 'trustPage.servingSetSelfHeal' });
      expect(await r().exists(TRUST_SERVING_REBUILD_LOCK_KEY)).toBe(1);
      expect(rebuilds()).toBe(0);
      warn.mockRestore();
    });
    it('no Redis client: the self-heal is a no-op', async () => {
      redisMock.client = null;
      scheduleServingSetRebuild('no-redis');
      await expect(servingSetRebuildSettled()).resolves.toBeUndefined();
    });
  });
  describe('#9087: every writer is an epoch-checked reconcile', () => {
    const ACME = { partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false };
    const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };

    it('a rebuild cannot drop a member committed between its DB read and its write', async () => {
      await markBuilt();
      // Read 1 is the rebuild: before it returns (no live rows yet), a publish commits and its reconcile reads
      // the new row and applies. Every later read sees the committed row.
      dbRows.reader = async () => {
        if (dbRows.reads === 1) { await refreshServingForPartner('p1'); return []; }
        return [ACME];
      };
      await rebuildServingSetFromDb();
      expect(r()._set.has('nw/acme')).toBe(true);
    });

    it('an older rebuild cannot overwrite a newer partner refresh', async () => {
      await markBuilt();
      r()._set.add('other/keep');
      // A partner was restored: its refresh re-adds the org member and the partner home after the rebuild read.
      const restored = [{ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: true }];
      dbRows.reader = async () => {
        if (dbRows.reads === 1) { await refreshServingForPartner('p1'); return [{ partnerSlug: 'other', orgSlug: 'keep', isPartnerHome: false }]; }
        if (dbRows.reads === 2) return restored;
        return [...restored, { partnerSlug: 'other', orgSlug: 'keep', isPartnerHome: false }];
      };
      await rebuildServingSetFromDb();
      expect([...r()._set].sort()).toEqual(['__built__', 'nw', 'nw/acme', 'other/keep']);
    });

    it('a delayed unpublish reconcile cannot remove a later publish', async () => {
      await markBuilt();
      dbRows.slugRows = [{ slug: 'nw' }];
      const reached = deferred(); const release = deferred();
      // A (unpublish) reads no rows and stalls; B (a later publish) reads the row and applies; A resumes.
      dbRows.reader = async () => {
        const n = dbRows.reads;
        if (n === 1) { reached.resolve(); await release.p; return []; }
        return [ACME];
      };
      const a = refreshServingForPartner('p1');
      await reached.p;
      await refreshServingForPartner('p1');
      expect(r()._set.has('nw/acme')).toBe(true);
      release.resolve();
      await a;
      expect(r()._set.has('nw/acme')).toBe(true);
      expect(dbRows.reads).toBe(3); // A read twice: its stale read conflicted and it re-read the DB
    });

    it('three consecutive conflicts fall back to a non-destructive apply and report once', async () => {
      await markBuilt();
      r()._set.add('other/keep');
      sentry.captureMessage.mockClear();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const real = r().eval.getMockImplementation()!;
      // Another writer bumps the epoch before every strict apply; only the merge apply goes through.
      r().eval.mockImplementation(async (...a: Parameters<typeof real>) => {
        if (a[8] !== 'merge') { await r().incr(a[2]); }
        return real(...a);
      });
      dbRows.rows = [ACME];
      await rebuildServingSetFromDb();
      expect([...r()._set].sort()).toEqual(['__built__', 'nw/acme', 'other/keep']);
      expect(dbRows.reads).toBe(3);
      expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventCode: 'trust_serving_reconcile_fallback' }));
      warn.mockRestore();
    });

    it('a Redis error drops the built marker so isServing falls through', async () => {
      await markBuilt();
      r()._set.add('nw/acme');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      r().eval.mockRejectedValue(new Error('READONLY'));
      dbRows.rows = [ACME];
      await expect(refreshServingForPartner('p1')).resolves.toBe('degraded');
      expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(0);
      expect(await isServing('nw/acme')).toBeNull();
      warn.mockRestore();
    });

    it('a degraded reconcile schedules the self-heal, so a set that kept its marker is rebuilt within the minute', async () => {
      await markBuilt();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      r().eval.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      r().del.mockRejectedValueOnce(new Error('ETIMEDOUT')); // the marker drop fails too: the marker survives
      dbRows.rows = [ACME];
      await expect(refreshServingForPartner('p1')).resolves.toBe('degraded');
      await servingSetRebuildSettled();
      expect(r()._set.has('nw/acme')).toBe(true); // the scheduled full rebuild re-read the DB and added it
      expect(rebuilds()).toBe(1);
      warn.mockRestore(); info.mockRestore();
    });

    it('a failed marker drop is reported, not only logged', async () => {
      sentry.captureException.mockClear();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      r().eval.mockRejectedValueOnce(new Error('READONLY'));
      r().del.mockRejectedValueOnce(new Error('READONLY'));
      r().set.mockResolvedValueOnce(null as never); // the self-heal lock is held elsewhere
      dbRows.rows = [ACME];
      await refreshServingForPartner('p1');
      await servingSetRebuildSettled();
      expect(sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'READONLY' }), undefined, { component: 'trustPage.servingSetDropMarker' });
      warn.mockRestore();
    });

    it('a post-commit refresh that fails on the DB drops the built marker and reports it (no hidden page until the hourly rebuild)', async () => {
      afterCommit.length = 0;
      sentry.captureException.mockClear();
      await markBuilt();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      dbRows.reader = async () => { throw new Error('db down'); };
      scheduleServingRefreshForPartner('p1', 'test');
      await afterCommit[0]!();
      expect(await r().exists(TRUST_SERVING_BUILT_KEY)).toBe(0);
      expect(sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }), undefined, { component: 'trustPage.servingRefreshAfterCommit' });
      warn.mockRestore();
    });

    it('refreshServingForPartner refuses to run inside a held DB context', async () => {
      dbRows.inContext = true;
      await expect(refreshServingForPartner('p1')).rejects.toThrow('refreshServingForPartner must run outside a held DB context');
    });

    it('scheduleServingRefreshForPartner still reconciles after commit', async () => {
      afterCommit.length = 0;
      await markBuilt();
      dbRows.rows = [ACME];
      scheduleServingRefreshForPartner('p1', 'test');
      expect(r()._set.has('nw/acme')).toBe(false);
      await afterCommit[0]!();
      expect(r()._set.has('nw/acme')).toBe(true);
    });
  });
  it('caches a payload for an hour and reads it back', async () => {
    await cacheSnapshotPayload('s1', { schemaVersion: 1 } as never);
    expect(r().setex).toHaveBeenCalledWith('trust:snapshot:s1', 3600, expect.any(String));
    expect(await readCachedSnapshotPayload('s1')).toEqual({ schemaVersion: 1 });
    expect(await readCachedSnapshotPayload('nope')).toBeNull();
  });
});
