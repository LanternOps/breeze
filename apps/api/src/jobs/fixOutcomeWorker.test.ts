import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ids: [] as string[],
  advance: vi.fn(), rebuild: vi.fn(), drift: vi.fn(async () => 2), stale: vi.fn(async () => ['p-1']),
  recountIds: vi.fn(async () => ['o-9']), recompute: vi.fn(async () => undefined), captureException: vi.fn(),
  stamp: vi.fn(async () => 1),
}));
vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); getRepeatableJobs = vi.fn(async () => []); removeRepeatableByKey = vi.fn(); close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.ids.map((id) => ({ id }))).then(r);
  return { db: chain };
});
vi.mock('../services/outcomeProbes', () => ({ inSystemDbContext: (fn: () => unknown) => fn() }));
vi.mock('../services/fixMemory/outcomeWatcher', () => ({ advanceOutcome: h.advance }));
vi.mock('../services/fixMemory/store', () => ({
  rebuildFixMemory: h.rebuild, markOwnerDriftStale: h.drift, stalePartnerIds: h.stale,
  recountRequestedOutcomeIds: h.recountIds, recomputeForOutcome: h.recompute, stampRebuildAttempt: h.stamp,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { runFixOutcomeSweep } from './fixOutcomeWorker';

describe('runFixOutcomeSweep', () => {
  beforeEach(() => { vi.clearAllMocks(); h.ids = ['o-1', 'o-2', 'o-3']; });

  it('advances every active outcome and keeps going past one that throws', async () => {
    h.advance.mockResolvedValueOnce('holding').mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('verified');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stats = await runFixOutcomeSweep(new Date('2026-11-02T00:00:00Z'));
    err.mockRestore();
    expect(h.advance).toHaveBeenCalledTimes(3);
    expect(stats).toEqual({ scanned: 3, errors: 1, recounted: 1, drifted: 2, rebuilt: 1 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('rebuilds stale partners (retry path for a failed erasure rebuild)', async () => {
    h.ids = [];
    await runFixOutcomeSweep();
    expect(h.rebuild).toHaveBeenCalledWith({ partnerId: 'p-1' }, expect.any(Date));
    expect(h.recompute).toHaveBeenCalledWith('o-9', expect.any(Date));
  });

  it('a failing owner-drift scan is reported and does not skip the rebuild pass (M6)', async () => {
    h.ids = [];
    const driftErr = new Error('drift scan failed');
    h.drift.mockRejectedValueOnce(driftErr);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stats = await runFixOutcomeSweep();
    err.mockRestore();
    expect(h.rebuild).toHaveBeenCalledWith({ partnerId: 'p-1' }, expect.any(Date));
    expect(stats).toMatchObject({ drifted: 0, rebuilt: 1 });
    expect(h.captureException).toHaveBeenCalledWith(driftErr);
  });

  it('stamps each partner\'s rebuild attempt BEFORE rebuilding it, so a failing rebuild still rotates (#7278)', async () => {
    h.ids = [];
    h.stale.mockResolvedValueOnce(['p-1', 'p-2']);
    h.rebuild.mockRejectedValueOnce(new Error('rebuild failed'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = new Date('2026-12-22T00:00:00Z');
    const stats = await runFixOutcomeSweep(now);
    err.mockRestore();
    expect(h.stamp.mock.calls).toEqual([['p-1', now], ['p-2', now]]);
    expect(h.stamp.mock.invocationCallOrder[0]!).toBeLessThan(h.rebuild.mock.invocationCallOrder[0]!);
    expect(h.stamp.mock.invocationCallOrder[1]!).toBeLessThan(h.rebuild.mock.invocationCallOrder[1]!);
    expect(stats.rebuilt).toBe(1);
  });

  it('a failed attempt stamp is reported and does not skip that partner\'s rebuild', async () => {
    h.ids = [];
    const stampErr = new Error('stamp failed');
    h.stamp.mockRejectedValueOnce(stampErr);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stats = await runFixOutcomeSweep();
    err.mockRestore();
    expect(h.rebuild).toHaveBeenCalledWith({ partnerId: 'p-1' }, expect.any(Date));
    expect(stats.rebuilt).toBe(1);
    expect(h.captureException).toHaveBeenCalledWith(stampErr);
  });
});
