import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Result = unknown[] | Error;
  const selectQueue: Result[] = [];
  const insertCalls: Array<{ values: unknown; conflict: unknown }> = [];
  const updateCalls: Array<{ set: Record<string, unknown> }> = [];
  const updateResults: unknown[][] = [];
  const insertErrors: Array<Error | undefined> = [];
  const publish = vi.fn(async () => 'published');

  function thenable<T>(result: T | Error, extra: Record<string, unknown> = {}) {
    const self: Record<string, unknown> = {
      ...extra,
      then: (res: (v: T) => unknown, rej: (e: unknown) => unknown) =>
        (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(res, rej)
    };
    return self;
  }
  function selectChain(result: Result) {
    const chain: Record<string, unknown> = thenable(result);
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => chain;
    return chain;
  }
  return { selectQueue, insertCalls, updateCalls, updateResults, insertErrors, publish, thenable, selectChain };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      if (h.selectQueue.length === 0) throw new Error('unexpected db.select');
      return h.selectChain(h.selectQueue.shift()!);
    }),
    insert: vi.fn(() => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: (conflict: unknown) => {
          h.insertCalls.push({ values, conflict });
          const err = h.insertErrors.shift();
          return h.thenable(err ?? []);
        }
      })
    })),
    update: vi.fn(() => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            h.updateCalls.push({ set });
            return h.thenable(h.updateResults.shift() ?? []);
          }
        })
      })
    }))
  },
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  runAfterDbContextCommit: vi.fn((_label: string, work: () => unknown) => { void work(); })
}));

vi.mock('./clusterCacheBus', () => ({
  getClusterCacheBus: () => ({ publish: h.publish })
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { captureException } from './sentry';
import { getClusterCacheTarget } from './clusterCacheRegistry';
import {
  ENTITLEMENT_CACHE_STALE_CEILING_MS,
  ENTITLEMENT_CACHE_TTL_MS,
  ENTITLEMENT_CLUSTER_CACHE_NAME,
  EntitlementLimitsError,
  EntitlementResolutionError,
  __resetEntitlementCacheForTests,
  getEntitlementLimits,
  getEntitlements,
  hasEntitlement,
  invalidateEntitlementCache,
  isEntitlementRowLive,
  resolveEntitlementRows,
  revokeEntitlementRow,
  upsertEntitlementRow,
  type EntitlementRowLike
} from './entitlements';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const PARTNER = '11111111-1111-4111-8111-111111111111';
const WISP_PRO = { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 };

function row(partial: Partial<EntitlementRowLike>): EntitlementRowLike {
  return {
    featureKey: 'wisp', state: 'enabled', source: 'billing', limits: null,
    expiresAt: null, revokedAt: null, reason: null, ...partial
  };
}

function queueLoad(plan: string | null, rows: EntitlementRowLike[] = []) {
  h.selectQueue.push(plan === null ? [] : [{ plan }]);
  h.selectQueue.push(rows);
}

beforeEach(() => {
  h.selectQueue.length = 0;
  h.insertCalls.length = 0;
  h.updateCalls.length = 0;
  h.updateResults.length = 0;
  h.insertErrors.length = 0;
  h.publish.mockClear();
  vi.mocked(db.select).mockClear();
  vi.mocked(captureException).mockClear();
  vi.mocked(runAfterDbContextCommit).mockClear();
  vi.mocked(withSystemDbAccessContext).mockClear();
  __resetEntitlementCacheForTests();
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveEntitlementRows (pure)', () => {
  it('no rows → plan default per key, source "plan", limits = defaultLimits[plan] ?? null', () => {
    const pro = resolveEntitlementRows([], 'pro', NOW);
    expect(pro.wisp).toEqual({
      key: 'wisp', state: 'enabled', source: 'plan', limits: WISP_PRO,
      expiresAt: null, graceUntil: null, reason: null
    });
    const free = resolveEntitlementRows([], 'free', NOW);
    expect(free.wisp).toMatchObject({ state: 'disabled', source: 'plan', limits: null });
    expect(Object.keys(free).sort()).toEqual(['onboarding_supervisor', 'verified_library', 'wisp']);
  });

  it('billing enabled beats plan default; manual beats license beats billing', () => {
    expect(resolveEntitlementRows([row({ source: 'billing' })], 'free', NOW).wisp)
      .toMatchObject({ state: 'enabled', source: 'billing' });
    const all = resolveEntitlementRows([
      row({ source: 'billing', state: 'disabled' }),
      row({ source: 'manual', state: 'enabled', reason: 'comp for beta partner' }),
      row({ source: 'license', state: 'disabled' })
    ], 'free', NOW);
    expect(all.wisp).toMatchObject({ state: 'enabled', source: 'manual', reason: 'comp for beta partner' });
    expect(resolveEntitlementRows([row({ source: 'billing' }), row({ source: 'license', state: 'disabled' })], 'pro', NOW).wisp)
      .toMatchObject({ state: 'disabled', source: 'license' });
  });

  it('manual disabled beats billing enabled', () => {
    const r = resolveEntitlementRows([
      row({ source: 'billing', state: 'enabled' }),
      row({ source: 'manual', state: 'disabled', reason: 'abuse hold' })
    ], 'pro', NOW);
    expect(r.wisp).toMatchObject({ state: 'disabled', source: 'manual', reason: 'abuse hold' });
  });

  it('a revoked manual row reveals the billing row beneath it', () => {
    const r = resolveEntitlementRows([
      row({ source: 'billing', state: 'enabled' }),
      row({ source: 'manual', state: 'disabled', reason: 'hold', revokedAt: new Date(NOW.getTime() - 1000) })
    ], 'free', NOW);
    expect(r.wisp).toMatchObject({ state: 'enabled', source: 'billing' });
  });

  it('expired-within-grace row still wins and reports graceUntil = expiresAt + 14 d', () => {
    const expiresAt = new Date(NOW.getTime() - 1000);
    const r = resolveEntitlementRows([row({ source: 'billing', expiresAt })], 'free', NOW);
    expect(r.wisp).toMatchObject({ state: 'enabled', source: 'billing', expiresAt });
    expect(r.wisp.graceUntil?.getTime()).toBe(expiresAt.getTime() + 14 * DAY);
  });

  it('expired beyond grace drops out of the fold', () => {
    const expiresAt = new Date(NOW.getTime() - 14 * DAY - 1000);
    expect(resolveEntitlementRows([row({ source: 'billing', expiresAt })], 'free', NOW).wisp)
      .toMatchObject({ state: 'disabled', source: 'plan' });
    // Review focus 2: revoked manual + billing expired 20 days ago → plan default, not the stale billing row.
    const r = resolveEntitlementRows([
      row({ source: 'manual', state: 'enabled', reason: 'r', revokedAt: new Date(NOW.getTime() - DAY) }),
      row({ source: 'billing', state: 'enabled', expiresAt: new Date(NOW.getTime() - 20 * DAY) })
    ], 'free', NOW);
    expect(r.wisp).toMatchObject({ state: 'disabled', source: 'plan', expiresAt: null, graceUntil: null });
  });

  it.each([
    ['-1s', -1000, true],
    ['+1s (after expiry)', 1000, true],
    ['+14d-1s', 14 * DAY - 1000, true],
    ['+14d', 14 * DAY, false],
    ['+14d+1s', 14 * DAY + 1000, false]
  ] as const)('grace boundary %s live=%s', (_label, offset, live) => {
    const expiresAt = new Date(NOW.getTime());
    const now = new Date(NOW.getTime() + offset);
    expect(isEntitlementRowLive(row({ expiresAt }), now)).toBe(live);
  });

  it('unknown key in DB is ignored and the other keys still resolve', () => {
    const r = resolveEntitlementRows([
      row({ featureKey: 'ai_for_office', source: 'manual', reason: 'x' }),
      row({ featureKey: 'wisp', source: 'billing' })
    ], 'free', NOW);
    expect(Object.keys(r).sort()).toEqual(['onboarding_supervisor', 'verified_library', 'wisp']);
    expect(r.wisp).toMatchObject({ state: 'enabled', source: 'billing' });
  });

  it('an enabled row with no limits on a plan with no defaults gets the entry-tier defaults, never null', () => {
    const r = resolveEntitlementRows([row({ source: 'manual', reason: 'comp', limits: null })], 'free', NOW);
    expect(r.wisp).toMatchObject({ state: 'enabled', source: 'manual', limits: WISP_PRO });
    // A DISABLED winner on a plan without defaults keeps null limits.
    expect(resolveEntitlementRows([row({ source: 'manual', state: 'disabled', reason: 'hold' })], 'free', NOW).wisp.limits)
      .toBeNull();
  });

  it('stored limits that fail the key schema fall back to the defaults and are reported', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = resolveEntitlementRows([row({ limits: { maxGrants: 'lots' } })], 'enterprise', NOW);
    expect(r.wisp.limits).toEqual({ maxGrants: 100, budgetCentsPerDayCeiling: 2500, minFloorTickMinutes: 15 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid stored limits'));
    warn.mockRestore();
  });

  it('row limits override defaultLimits; null row limits fall back to defaultLimits[plan]', () => {
    const custom = { maxGrants: 3, budgetCentsPerDayCeiling: 50, minFloorTickMinutes: 30 };
    expect(resolveEntitlementRows([row({ limits: custom })], 'pro', NOW).wisp.limits).toEqual(custom);
    expect(resolveEntitlementRows([row({ limits: null })], 'pro', NOW).wisp.limits).toEqual(WISP_PRO);
    // Enabled above its plan → entry-tier defaults (see the case above), not null.
    expect(resolveEntitlementRows([row({ limits: null })], 'free', NOW).wisp.limits).toEqual(WISP_PRO);
  });
});

describe('getEntitlements cache', () => {
  it('second call within 60 s does not hit the DB', async () => {
    queueLoad('pro');
    const a = await getEntitlements(PARTNER);
    vi.advanceTimersByTime(ENTITLEMENT_CACHE_TTL_MS - 1);
    const b = await getEntitlements(PARTNER);
    expect(b).toBe(a);
    expect(a.plan).toBe('pro');
    expect(db.select).toHaveBeenCalledTimes(2); // one load = partner + rows
  });

  it('partner row missing → plan "free"', async () => {
    queueLoad(null);
    const r = await getEntitlements(PARTNER);
    expect(r.plan).toBe('free');
    expect(r.entitlements.wisp.state).toBe('disabled');
  });

  it('after 60 s it reloads', async () => {
    queueLoad('pro');
    await getEntitlements(PARTNER);
    vi.advanceTimersByTime(ENTITLEMENT_CACHE_TTL_MS);
    queueLoad('free');
    const r = await getEntitlements(PARTNER);
    expect(r.plan).toBe('free');
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it('at 4 min with the DB throwing it serves the stale entry', async () => {
    queueLoad('pro');
    const first = await getEntitlements(PARTNER);
    vi.advanceTimersByTime(240_000);
    h.selectQueue.push(new Error('db down'));
    const r = await getEntitlements(PARTNER);
    expect(r).toBe(first);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('at 6 min with the DB throwing it throws EntitlementResolutionError', async () => {
    queueLoad('pro');
    await getEntitlements(PARTNER);
    vi.advanceTimersByTime(360_000);
    h.selectQueue.push(new Error('db down'));
    await expect(getEntitlements(PARTNER)).rejects.toBeInstanceOf(EntitlementResolutionError);
    expect(ENTITLEMENT_CACHE_STALE_CEILING_MS).toBe(300_000);
  });

  it('a throwing load with no cached entry throws EntitlementResolutionError and reports it', async () => {
    h.selectQueue.push(new Error('db down'));
    await expect(getEntitlements(PARTNER)).rejects.toBeInstanceOf(EntitlementResolutionError);
    expect(captureException).toHaveBeenCalledTimes(1);
    h.selectQueue.push(new Error('db down'));
    await expect(hasEntitlement(PARTNER, 'wisp')).rejects.toBeInstanceOf(EntitlementResolutionError);
  });

  it('a bug in the fold is NOT masked as a transient resolution failure nor served stale', async () => {
    queueLoad('pro');
    await getEntitlements(PARTNER);
    vi.advanceTimersByTime(ENTITLEMENT_CACHE_TTL_MS);
    // expiresAt that is not a Date makes the pure fold throw a TypeError.
    queueLoad('pro', [row({ expiresAt: 'not-a-date' as unknown as Date })]);
    const err = await getEntitlements(PARTNER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(EntitlementResolutionError);
  });

  it('invalidateEntitlementCache(partnerId) drops the entry and publishes {cache:"partner-entitlements", key: partnerId}', async () => {
    queueLoad('pro');
    await getEntitlements(PARTNER);
    invalidateEntitlementCache(PARTNER);
    expect(h.publish).toHaveBeenCalledWith(ENTITLEMENT_CLUSTER_CACHE_NAME, PARTNER);
    expect(ENTITLEMENT_CLUSTER_CACHE_NAME).toBe('partner-entitlements');
    queueLoad('free');
    expect((await getEntitlements(PARTNER)).plan).toBe('free');
  });

  it('invalidateEntitlementCache() drops every entry and publishes key null', async () => {
    queueLoad('pro');
    await getEntitlements(PARTNER);
    invalidateEntitlementCache();
    expect(h.publish).toHaveBeenCalledWith(ENTITLEMENT_CLUSTER_CACHE_NAME, null);
    queueLoad('enterprise');
    expect((await getEntitlements(PARTNER)).plan).toBe('enterprise');
  });

  it('a cluster invalidation from another instance drops the local entry without re-publishing', async () => {
    queueLoad('pro');
    await getEntitlements(PARTNER);
    getClusterCacheTarget(ENTITLEMENT_CLUSTER_CACHE_NAME)!.invalidate(PARTNER);
    expect(h.publish).not.toHaveBeenCalled();
    queueLoad('free');
    expect((await getEntitlements(PARTNER)).plan).toBe('free');
  });

  it('a load that started before an invalidate is returned but not stored', async () => {
    let release!: (v: unknown[]) => void;
    h.selectQueue.push(new Promise<unknown[]>((r) => { release = r; }) as unknown as unknown[]);
    h.selectQueue.push([]);
    const pending = getEntitlements(PARTNER);
    invalidateEntitlementCache(PARTNER);
    release([{ plan: 'pro' }]);
    expect((await pending).plan).toBe('pro');
    queueLoad('free');
    expect((await getEntitlements(PARTNER)).plan).toBe('free');
  });

  it('hasEntitlement / getEntitlementLimits read the resolved set', async () => {
    queueLoad('pro');
    expect(await hasEntitlement(PARTNER, 'wisp')).toBe(true);
    expect(await getEntitlementLimits(PARTNER, 'wisp')).toEqual(WISP_PRO);
  });
});

describe('write primitives', () => {
  const base = {
    partnerId: PARTNER, featureKey: 'wisp' as const, source: 'manual' as const, state: 'enabled' as const,
    expiresAt: null, reason: 'comp for design partner', updatedBy: null
  };

  it('upsertEntitlementRow validates limits against the key schema and throws EntitlementLimitsError', async () => {
    await expect(upsertEntitlementRow({ ...base, limits: { maxGrants: -1 } })).rejects.toBeInstanceOf(EntitlementLimitsError);
    await expect(upsertEntitlementRow({ ...base, limits: { ...WISP_PRO, extra: 1 } })).rejects.toBeInstanceOf(EntitlementLimitsError);
    expect(h.insertCalls).toHaveLength(0);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('upsertEntitlementRow writes ON CONFLICT (partner_id, feature_key, source) DO UPDATE clearing revoked_at, then invalidates after commit', async () => {
    queueLoad('pro');
    await getEntitlements(PARTNER);
    vi.mocked(withSystemDbAccessContext).mockClear();
    vi.mocked(runOutsideDbContext).mockClear();
    await upsertEntitlementRow({ ...base, limits: WISP_PRO });
    // The write escapes any caller context and runs system-scoped.
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledWith(expect.any(Function), 'entitlements.write');
    expect(h.insertCalls).toHaveLength(1);
    const { values, conflict } = h.insertCalls[0] as { values: Record<string, unknown>; conflict: { target: unknown[]; set: Record<string, unknown> } };
    expect(values).toMatchObject({ partnerId: PARTNER, featureKey: 'wisp', source: 'manual', state: 'enabled', limits: WISP_PRO });
    expect(conflict.target).toHaveLength(3);
    expect(conflict.set).toMatchObject({ state: 'enabled', revokedAt: null, limits: WISP_PRO, reason: base.reason });
    expect(runAfterDbContextCommit).toHaveBeenCalledWith('entitlements.invalidate', expect.any(Function));
    expect(h.publish).toHaveBeenCalledWith(ENTITLEMENT_CLUSTER_CACHE_NAME, PARTNER);
    queueLoad('free');
    expect((await getEntitlements(PARTNER)).plan).toBe('free'); // cache dropped
  });

  it('upsertEntitlementRow accepts null limits for a key with a schema', async () => {
    await upsertEntitlementRow({ ...base, limits: null });
    expect(h.insertCalls).toHaveLength(1);
  });

  it('a failed write does not invalidate', async () => {
    h.insertErrors.push(new Error('constraint'));
    await expect(upsertEntitlementRow({ ...base, limits: null })).rejects.toThrow('constraint');
    expect(runAfterDbContextCommit).not.toHaveBeenCalled();
  });

  it('revokeEntitlementRow sets revoked_at + reason on the live row and returns false when none is live', async () => {
    h.updateResults.push([{ id: 'x' }]);
    expect(await revokeEntitlementRow({ partnerId: PARTNER, featureKey: 'wisp', source: 'manual', reason: 'hold lifted, see ticket' })).toBe(true);
    expect(h.updateCalls[0]!.set).toHaveProperty('revokedAt');
    expect(h.updateCalls[0]!.set.reason).toBe('hold lifted, see ticket');
    expect(h.publish).toHaveBeenCalledWith(ENTITLEMENT_CLUSTER_CACHE_NAME, PARTNER);

    h.publish.mockClear();
    h.updateResults.push([]);
    expect(await revokeEntitlementRow({ partnerId: PARTNER, featureKey: 'wisp', source: 'manual', reason: null })).toBe(false);
    expect(h.publish).not.toHaveBeenCalled();
  });
});
