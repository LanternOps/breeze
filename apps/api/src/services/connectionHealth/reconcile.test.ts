import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every collaborator of the default deps is mocked, so importing the module
// opens no pool or Redis client. runReconcile tests inject their deps; the
// runKindInSystemScope tests drive the mocked DB helpers.
const calls: string[] = [];
const tightenMock = vi.fn(async (_db: unknown, ms: number) => { calls.push(`tighten:${ms}`); return 0; });
const loadTrackedMock = vi.fn();
const hasIncidentsMock = vi.fn(async (..._a: unknown[]) => { calls.push('has-rows'); return false; });
const executeMock = vi.fn(async (..._a: unknown[]) => { calls.push('lock'); return [{ acquired: true }]; });
const applyActionsMock = vi.fn();
const planMock = vi.fn();

vi.mock('../../db', () => ({
  db: { execute: (...a: unknown[]) => executeMock(...a) },
  runOutsideDbContext: (fn: () => unknown) => { calls.push('outside'); return fn(); },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>, label?: string) => {
    calls.push(`system:${label}`);
    return fn();
  },
}));
vi.mock('../../db/lockTimeout', () => ({ tightenStatementTimeout: (...a: [unknown, number]) => tightenMock(...a) }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('./notifier', () => ({ deliverPendingNotices: vi.fn() }));
vi.mock('./sources', () => ({ HEALTH_SOURCES: [] }));
vi.mock('./store', () => ({
  loadTracked: (...a: unknown[]) => loadTrackedMock(...a),
  hasIncidentsForKind: (...a: unknown[]) => hasIncidentsMock(...a),
  applyActions: (...a: unknown[]) => applyActionsMock(...a),
  deleteExpiredResolved: vi.fn(),
}));
vi.mock('./transitions', () => ({ planTransitions: (...a: unknown[]) => planMock(...a) }));

import { runKindInSystemScope, runReconcile } from './reconcile';
import type { HealthSource } from './types';

// The contract fields the reconciler never reads.
const CONTRACT_STUB = { tables: [] as string[], fixHrefs: [] as string[], brokenQuery: () => ({ getSQL: () => { throw new Error('unused'); } }) } as Pick<HealthSource, 'tables' | 'fixHrefs' | 'brokenQuery'>;

function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, unknown[]>();
  return {
    store,
    ttls,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...ex: unknown[]) => { store.set(k, v); if (ex.length) ttls.set(k, ex); return 'OK' as const; }),
    incr: vi.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

const src = (kind: string, intervalMinutes: number): HealthSource => ({
  kind: kind as HealthSource['kind'],
  intervalMinutes,
  ...CONTRACT_STUB,
  observe: async () => { throw new Error('observe must not be called; runKind is injected'); },
});
const okCounts = { opened: 0, resolved: 0, pending: 0, observations: 0 };
const noopsExceptAlert = {
  deliver: async () => ({ delivered: 0, failed: 0, zeroRecipients: 0 }),
  retention: async () => 0,
};
const noops = { ...noopsExceptAlert, alert: async () => true };
const T0 = new Date('2026-10-15T12:02:00.000Z');
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runReconcile', () => {
  it('runs a due kind, records last-ok, and seeds on its first run only', async () => {
    const redis = fakeRedis();
    const runKind = vi.fn().mockResolvedValue({ opened: 1, resolved: 0, pending: 0, observations: 1 });
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => T0, ...noops });
    expect(runKind).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'a' }), T0, true);
    expect(redis.store.get('connection-health:kind:a:last-ok')).toBe(String(T0.getTime()));
    expect(redis.store.get('connection-health:kind:a:seeded')).toBe('1');
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => plusMin(T0, 15), ...noops });
    expect(runKind).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'a' }), plusMin(T0, 15), false);
  });

  it('nudge mode runs the kind even when not due, delivers notices, and skips retention and the heartbeat (W4)', async () => {
    const redis = fakeRedis();
    const runKind = vi.fn().mockResolvedValue(okCounts);
    const retention = vi.fn(async () => 0);
    const deliver = vi.fn(async () => ({ delivered: 1, failed: 0, zeroRecipients: 0 }));
    await runReconcile({ sources: [src('a', 60)], redis, runKind, now: () => T0, ...noops });
    redis.store.delete('connection-health:reconcile:heartbeat');
    const r = await runReconcile({
      sources: [src('a', 60)], redis, runKind, now: () => plusMin(T0, 2), mode: 'nudge', deliver, retention, alert: async () => true,
    });
    expect(r.kinds[0]!.status).toBe('ok');
    expect(runKind).toHaveBeenCalledTimes(2);
    expect(runKind).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'a' }), plusMin(T0, 2), false);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(retention).not.toHaveBeenCalled();
    expect(redis.store.has('connection-health:reconcile:heartbeat')).toBe(false);
  });

  it('skips a kind whose interval has not elapsed', async () => {
    const redis = fakeRedis();
    const runKind = vi.fn().mockResolvedValue(okCounts);
    await runReconcile({ sources: [src('a', 60)], redis, runKind, now: () => T0, ...noops });
    const r = await runReconcile({ sources: [src('a', 60)], redis, runKind, now: () => plusMin(T0, 15), ...noops });
    expect(r.kinds[0]!.status).toBe('skipped_not_due');
    expect(runKind).toHaveBeenCalledTimes(1);
  });

  it('keeps a 15-minute kind due on a tick that fires slightly early', async () => {
    const redis = fakeRedis();
    const runKind = vi.fn().mockResolvedValue(okCounts);
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => T0, ...noops });
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => new Date(plusMin(T0, 15).getTime() - 20_000), ...noops });
    expect(runKind).toHaveBeenCalledTimes(2);
  });

  it("without Redis every kind is due in 'defer' mode, and a deferred kind is skipped_unseeded", async () => {
    const runKind = vi.fn().mockResolvedValue(okCounts);
    await runReconcile({ sources: [src('a', 60)], redis: null, runKind, now: () => T0, ...noops });
    await runReconcile({ sources: [src('a', 60)], redis: null, runKind, now: () => plusMin(T0, 1), ...noops });
    expect(runKind).toHaveBeenCalledTimes(2);
    expect(runKind.mock.calls.every((c) => c[2] === 'defer')).toBe(true);
    const deferred = vi.fn().mockResolvedValue('deferred');
    const r = await runReconcile({ sources: [src('a', 60)], redis: null, runKind: deferred, now: () => T0, ...noops });
    expect(r.kinds).toEqual([expect.objectContaining({ kind: 'a', status: 'skipped_unseeded' })]);
  });

  it("treats a kind as due and in 'defer' mode when Redis reads throw", async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('ECONNRESET'));
    redis.set.mockRejectedValue(new Error('ECONNRESET'));
    redis.del.mockRejectedValue(new Error('ECONNRESET'));
    const runKind = vi.fn().mockResolvedValue(okCounts);
    const r = await runReconcile({ sources: [src('a', 60)], redis, runKind, now: () => T0, ...noops });
    expect(runKind).toHaveBeenCalledWith(expect.objectContaining({ kind: 'a' }), T0, 'defer');
    expect(r.kinds[0]!.status).toBe('ok');
  });

  it('a failing source leaves its incidents untouched and others still run', async () => {
    const runKind = vi.fn(async (s: HealthSource) => { if (s.kind === ('a' as HealthSource['kind'])) throw new Error('boom'); return okCounts; });
    const redis = fakeRedis();
    const r = await runReconcile({ sources: [src('a', 15), src('b', 15)], redis, runKind, now: () => T0, ...noops });
    expect(r.kinds.map((k) => [k.kind, k.status])).toEqual([['a', 'failed'], ['b', 'ok']]);
    expect(r.kinds[0]!.error).toBe('boom');
    // The failed kind stays due and unseeded; the other kind is recorded.
    expect(redis.store.has('connection-health:kind:a:last-ok')).toBe(false);
    expect(redis.store.has('connection-health:kind:a:seeded')).toBe(false);
    expect(redis.store.has('connection-health:kind:b:last-ok')).toBe(true);
  });

  it('alerts ops exactly once when a kind fails three runs in a row, and resets on success', async () => {
    const redis = fakeRedis();
    const alert = vi.fn().mockResolvedValue(true);
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 4; i += 1) {
      await runReconcile({ sources: [src('a', 15)], redis, runKind: failing, alert, now: () => plusMin(T0, 15 * i), ...noopsExceptAlert });
    }
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0]).toMatchObject({ title: expect.stringContaining('a') });
    await runReconcile({ sources: [src('a', 15)], redis, runKind: vi.fn().mockResolvedValue(okCounts), alert, now: () => plusMin(T0, 60), ...noopsExceptAlert });
    expect(redis.store.has('connection-health:kind:a:failures')).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      await runReconcile({ sources: [src('a', 15)], redis, runKind: failing, alert, now: () => plusMin(T0, 75 + 15 * i), ...noopsExceptAlert });
    }
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('a throwing ops alert does not abort the run', async () => {
    const redis = fakeRedis();
    redis.store.set('connection-health:kind:a:failures', '2');
    const alert = vi.fn().mockRejectedValue(new Error('webhook down'));
    const deliver = vi.fn().mockResolvedValue({ delivered: 0, failed: 0 });
    const r = await runReconcile({
      sources: [src('a', 15), src('b', 15)], redis, alert, deliver, retention: async () => 0,
      runKind: vi.fn(async (s: HealthSource) => { if (s.kind === ('a' as HealthSource['kind'])) throw new Error('boom'); return okCounts; }),
      now: () => T0,
    });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(r.kinds.map((k) => k.status)).toEqual(['failed', 'ok']);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('stops starting kinds once the budget is spent and marks the rest skipped_budget', async () => {
    let t = T0.getTime();
    const now = () => new Date(t);
    const runKind = vi.fn(async () => { t += 40_000; return okCounts; });
    const r = await runReconcile({ sources: [src('a', 15), src('b', 15), src('c', 15)], redis: fakeRedis(), runKind, now, budgetMs: 60_000, ...noops });
    expect(r.kinds.map((k) => k.status)).toEqual(['ok', 'ok', 'skipped_budget']);
    expect(runKind).toHaveBeenCalledTimes(2);
  });

  it('runs due kinds oldest last-ok first, so a tight budget cannot starve the same kinds every run', async () => {
    const redis = fakeRedis();
    redis.store.set('connection-health:kind:a:last-ok', String(plusMin(T0, -30).getTime()));
    redis.store.set('connection-health:kind:c:last-ok', String(plusMin(T0, -60).getTime()));
    let t = T0.getTime();
    const runKind = vi.fn(async (_source: HealthSource, _now: Date, _seed: unknown) => { t += 40_000; return okCounts; });
    const r = await runReconcile({ sources: [src('a', 15), src('b', 15), src('c', 15)], redis, runKind, now: () => new Date(t), budgetMs: 60_000, ...noops });
    expect(runKind.mock.calls.map((c) => c[0].kind)).toEqual(['b', 'c']);
    expect(r.kinds.map((k) => [k.kind, k.status])).toEqual([['b', 'ok'], ['c', 'ok'], ['a', 'skipped_budget']]);
  });

  it('reports zero-recipient notices in the run result', async () => {
    const r = await runReconcile({
      sources: [], redis: null, now: () => T0, retention: async () => 0, alert: async () => true,
      deliver: async () => ({ delivered: 2, failed: 0, zeroRecipients: 1 }),
    });
    expect(r.notices).toEqual({ delivered: 2, failed: 0, zeroRecipients: 1 });
  });

  it('delivers notices and runs retention after kinds, and writes the heartbeat', async () => {
    const redis = fakeRedis();
    const order: string[] = [];
    const runKind = vi.fn(async () => { order.push('kind'); return okCounts; });
    const deliver = vi.fn(async () => { order.push('deliver'); return { delivered: 2, failed: 0, zeroRecipients: 0 }; });
    const retention = vi.fn(async () => { order.push('retention'); return 3; });
    const r = await runReconcile({ sources: [src('a', 15)], redis, runKind, deliver, retention, alert: vi.fn(), now: () => T0 });
    expect(order).toEqual(['kind', 'deliver', 'retention']);
    expect(r).toMatchObject({ notices: { delivered: 2, failed: 0 }, retained: 3 });
    expect(redis.store.get('connection-health:reconcile:heartbeat')).toBe(T0.toISOString());
    expect(redis.ttls.get('connection-health:reconcile:heartbeat')).toEqual(['EX', 3600]);
  });

  it('delivers notices even when every kind failed', async () => {
    const deliver = vi.fn().mockResolvedValue({ delivered: 0, failed: 0 });
    await runReconcile({ sources: [src('a', 15)], redis: fakeRedis(), runKind: vi.fn().mockRejectedValue(new Error('boom')), deliver, retention: async () => 0, alert: async () => true, now: () => T0 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a delivery failure still runs retention, writes no heartbeat, and fails the job', async () => {
    const redis = fakeRedis();
    const retention = vi.fn().mockResolvedValue(0);
    await expect(runReconcile({
      sources: [src('a', 15)], redis, runKind: vi.fn().mockResolvedValue(okCounts),
      deliver: vi.fn().mockRejectedValue(new Error('pool exhausted')), retention, alert: async () => true, now: () => T0,
    })).rejects.toThrow('pool exhausted');
    expect(retention).toHaveBeenCalledTimes(1);
    expect(redis.store.has('connection-health:reconcile:heartbeat')).toBe(false);
    // The kind's own work committed and is still recorded.
    expect(redis.store.get('connection-health:kind:a:seeded')).toBe('1');
  });

  it('a kind whose lock another run holds is skipped_locked: no failure, no success, still due', async () => {
    const redis = fakeRedis();
    const alert = vi.fn().mockResolvedValue(true);
    redis.store.set('connection-health:kind:a:failures', '2');
    const runKind = vi.fn().mockResolvedValue('locked');
    const r = await runReconcile({ sources: [src('a', 15), src('b', 15)], redis, runKind: vi.fn(async (s: HealthSource) => (s.kind === ('a' as HealthSource['kind']) ? runKind() : okCounts)), alert, now: () => T0, ...noopsExceptAlert });
    expect(r.kinds.map((k) => [k.kind, k.status])).toEqual([['a', 'skipped_locked'], ['b', 'ok']]);
    expect(redis.store.get('connection-health:kind:a:failures')).toBe('2');
    expect(redis.store.has('connection-health:kind:a:last-ok')).toBe(false);
    expect(redis.store.has('connection-health:kind:a:seeded')).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it('does not mark a kind seeded when the seed run failed', async () => {
    const redis = fakeRedis();
    const runKind = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(okCounts);
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => T0, ...noops });
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => plusMin(T0, 15), ...noops });
    expect(runKind.mock.calls.map((c) => c[2])).toEqual([true, true]);
  });

  it('marks seeded only after the kind committed', async () => {
    const redis = fakeRedis();
    let seededDuringRun: boolean | null = null;
    const runKind = vi.fn(async () => { seededDuringRun = redis.store.has('connection-health:kind:a:seeded'); return okCounts; });
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => T0, ...noops });
    expect(seededDuringRun).toBe(false);
    expect(redis.store.get('connection-health:kind:a:seeded')).toBe('1');
  });
});

describe('runKindInSystemScope', () => {
  const tracked = [{ id: 'i1', sourceId: 's1', severity: 'permanent', openedAt: T0, resolvedAt: null, healthyStreak: 0 }];

  it('runs load → observe → plan → apply in one system transaction with a 5s statement timeout', async () => {
    const observation = { sourceId: 's2' };
    const source: HealthSource = {
      kind: 'oauth_grant',
      intervalMinutes: 15,
      ...CONTRACT_STUB,
      observe: vi.fn(async () => { calls.push('observe'); return [observation] as never; }),
    };
    loadTrackedMock.mockImplementation(async () => { calls.push('load'); return tracked; });
    planMock.mockImplementation(() => { calls.push('plan'); return [{ type: 'deletePending', incidentId: 'i1' }]; });
    applyActionsMock.mockImplementation(async () => { calls.push('apply'); return { opened: 1, resolved: 2, pending: 3 }; });

    const r = await runKindInSystemScope(source, T0, true);

    expect(r).toEqual({ opened: 1, resolved: 2, pending: 3, observations: 1, seeded: true });
    expect(calls).toEqual(['outside', 'system:connectionHealth.reconcile.oauth_grant', 'lock', 'tighten:5000', 'has-rows', 'load', 'observe', 'plan', 'apply']);
    expect(hasIncidentsMock).toHaveBeenCalledWith('oauth_grant');
    expect(loadTrackedMock).toHaveBeenCalledWith('oauth_grant', T0, 60 * 60 * 1000);
    expect(source.observe).toHaveBeenCalledWith(T0, ['s1']);
    expect(planMock).toHaveBeenCalledWith({ observations: [observation], tracked, now: T0, seed: true, reopenWindowMs: 60 * 60 * 1000 });
    expect(applyActionsMock).toHaveBeenCalledWith([{ type: 'deletePending', incidentId: 'i1' }], T0);
  });

  it('runs prepare() first, outside any DB context, before the kind transaction opens (W4)', async () => {
    const source: HealthSource = {
      kind: 'google_workspace',
      intervalMinutes: 30,
      ...CONTRACT_STUB,
      prepare: vi.fn(async () => { calls.push('prepare'); }),
      observe: vi.fn(async () => { calls.push('observe'); return []; }),
    };
    loadTrackedMock.mockResolvedValue([]);
    planMock.mockReturnValue([]);
    applyActionsMock.mockResolvedValue({ opened: 0, resolved: 0, pending: 0 });

    await runKindInSystemScope(source, T0, false);

    expect(calls.slice(0, 3)).toEqual(['outside', 'prepare', 'outside']);
    expect(calls[3]).toBe('system:connectionHealth.reconcile.google_workspace');
    expect(source.prepare).toHaveBeenCalledWith(T0);
  });

  it('a prepare() failure fails the kind before its transaction opens', async () => {
    const source: HealthSource = {
      kind: 'google_workspace',
      intervalMinutes: 30,
      ...CONTRACT_STUB,
      prepare: vi.fn(async () => { throw new Error('claim failed'); }),
      observe: vi.fn(async () => []),
    };
    await expect(runKindInSystemScope(source, T0, false)).rejects.toThrow('claim failed');
    expect(calls.some((c) => c.startsWith('system:'))).toBe(false);
    expect(source.observe).not.toHaveBeenCalled();
  });

  it('a seed candidate does not seed when the kind already has incident rows (lost Redis key)', async () => {
    loadTrackedMock.mockResolvedValue(tracked);
    hasIncidentsMock.mockResolvedValueOnce(true);
    planMock.mockReturnValue([]);
    applyActionsMock.mockResolvedValue({ opened: 0, resolved: 0, pending: 0 });
    const source: HealthSource = { kind: 'oauth_grant', intervalMinutes: 15, ...CONTRACT_STUB, observe: async () => [] };
    const r = await runKindInSystemScope(source, T0, true);
    expect(planMock).toHaveBeenCalledWith(expect.objectContaining({ seed: false }));
    expect(r).toMatchObject({ seeded: false });
  });

  it("defer mode skips a kind with no rows without observing it", async () => {
    loadTrackedMock.mockResolvedValue([]);
    hasIncidentsMock.mockResolvedValueOnce(false);
    const source: HealthSource = { kind: 'oauth_grant', intervalMinutes: 15, ...CONTRACT_STUB, observe: vi.fn(async () => []) };
    expect(await runKindInSystemScope(source, T0, 'defer')).toBe('deferred');
    expect(source.observe).not.toHaveBeenCalled();
    expect(applyActionsMock).not.toHaveBeenCalled();
  });

  it("defer mode runs a kind that has rows normally, never seeding", async () => {
    loadTrackedMock.mockResolvedValue(tracked);
    hasIncidentsMock.mockResolvedValueOnce(true);
    planMock.mockReturnValue([]);
    applyActionsMock.mockResolvedValue({ opened: 0, resolved: 0, pending: 0 });
    const source: HealthSource = { kind: 'oauth_grant', intervalMinutes: 15, ...CONTRACT_STUB, observe: async () => [] };
    expect(await runKindInSystemScope(source, T0, 'defer')).toMatchObject({ seeded: false });
    expect(planMock).toHaveBeenCalledWith(expect.objectContaining({ seed: false }));
  });

  it('a non-seed run never checks for rows', async () => {
    loadTrackedMock.mockResolvedValue(tracked);
    planMock.mockReturnValue([]);
    applyActionsMock.mockResolvedValue({ opened: 0, resolved: 0, pending: 0 });
    const source: HealthSource = { kind: 'oauth_grant', intervalMinutes: 15, ...CONTRACT_STUB, observe: async () => [] };
    await runKindInSystemScope(source, T0, false);
    expect(hasIncidentsMock).not.toHaveBeenCalled();
    expect(planMock).toHaveBeenCalledWith(expect.objectContaining({ seed: false }));
  });

  it('returns locked without touching incidents when the per-kind advisory lock is taken', async () => {
    executeMock.mockImplementationOnce(async () => { calls.push('lock'); return [{ acquired: false }]; });
    const source: HealthSource = { kind: 'oauth_grant', intervalMinutes: 15, ...CONTRACT_STUB, observe: vi.fn(async () => []) };
    expect(await runKindInSystemScope(source, T0, true)).toBe('locked');
    expect(calls).toEqual(['outside', 'system:connectionHealth.reconcile.oauth_grant', 'lock']);
    expect(source.observe).not.toHaveBeenCalled();
    expect(applyActionsMock).not.toHaveBeenCalled();
  });

  it('propagates an observe failure without applying anything', async () => {
    loadTrackedMock.mockResolvedValue(tracked);
    const source: HealthSource = { kind: 'oauth_grant', intervalMinutes: 15, ...CONTRACT_STUB, observe: async () => { throw new Error('boom'); } };
    await expect(runKindInSystemScope(source, T0, false)).rejects.toThrow('boom');
    expect(planMock).not.toHaveBeenCalled();
    expect(applyActionsMock).not.toHaveBeenCalled();
  });
});
