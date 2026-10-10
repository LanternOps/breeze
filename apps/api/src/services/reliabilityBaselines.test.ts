import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  returningInsert: vi.fn(), returningUpdate: vi.fn(), selectRows: vi.fn(),
  scoreAsOf: vi.fn(), recompute: vi.fn(), active: vi.fn(),
  insertValues: vi.fn(),
  afterExit: [] as Array<() => unknown>, tighten: vi.fn(), enqueue: vi.fn(), inSavepoint: false,
}));
vi.mock('../db', () => {
  const selectChain: any = {};
  for (const k of ['from', 'leftJoin', 'where', 'orderBy']) selectChain[k] = vi.fn(() => selectChain);
  selectChain.limit = vi.fn(() => m.selectRows());
  selectChain.then = (res: any, rej: any) => Promise.resolve(m.selectRows()).then(res, rej);
  return {
    withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
      m.inSavepoint = true;
      try { return await fn(); } finally { m.inSavepoint = false; }
    }),
    runAfterDbContextExit: vi.fn((_label: string, work: () => unknown) => { m.afterExit.push(work); }),
    db: {
    execute: vi.fn(),
    insert: vi.fn(() => ({ values: (v: unknown) => { m.insertValues(v); return { onConflictDoNothing: () => ({ returning: m.returningInsert }) }; } })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: m.returningUpdate }) }) })),
    select: vi.fn(() => selectChain),
  } };
});
vi.mock('./reliabilityScoring', () => ({ scoreDeviceReliabilityAsOf: m.scoreAsOf, computeAndPersistDeviceReliability: m.recompute }));
vi.mock('./reliabilityBaselineQueries', () => ({ getActiveReliabilityBaseline: m.active }));
vi.mock('../db/lockTimeout', () => ({
  tightenLockTimeout: m.tighten,
  lockTimeoutWasChanged: (prior: number | null, bound: number) => prior !== null && (prior === 0 || prior > bound),
}));
vi.mock('../jobs/reliabilityWorker', () => ({ enqueueDeviceReliabilityComputation: m.enqueue }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { clearReliabilityBaseline, computeBeforeSnapshot, createReliabilityBaseline } from './reliabilityBaselines';

function lockTimeoutError(): Error {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
}

const device = { id: 'd1', orgId: 'o1', deviceRole: 'workstation', enrolledAt: null };
const values = { reliabilityScore: 50, uptimeScore: 100, crashScore: 10, hangScore: 100, serviceFailureScore: 100, hardwareErrorScore: 100,
  crashCount30d: 4, hangCount30d: 0, serviceFailureCount30d: 0, hardwareErrorCount30d: 0 };

describe('reliabilityBaselines service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.active.mockResolvedValue(null);
    m.scoreAsOf.mockResolvedValue({ values, coverageDays: 30, weightProfile: 'workstation' });
    m.selectRows.mockReturnValue([]);
    m.afterExit.length = 0;
    m.tighten.mockResolvedValue(0);
    m.enqueue.mockResolvedValue('job-1');
    m.recompute.mockResolvedValue(true);
  });
  it('computes the before snapshot against the chronological predecessor', async () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    const pred = { id: 'p', baselineAt: new Date('2026-09-20T00:00:00.000Z'), reason: 'reimaged', source: 'manual' };
    m.active.mockResolvedValue(pred);
    const snap = await computeBeforeSnapshot(device, at);
    expect(m.active).toHaveBeenCalledWith('d1', { before: at });
    expect(m.scoreAsOf).toHaveBeenCalledWith(device, at, pred);
    expect(snap.counts30d.crashes).toBe(4);
  });
  it('returns null and does not recompute on an idempotent conflict', async () => {
    m.returningInsert.mockResolvedValue([]);
    const out = await createReliabilityBaseline({ device, reason: 'reimaged', baselineAt: new Date(), note: null,
      source: 'bare_metal_recovery', sourceRef: 'r1', createdBy: null, recompute: true });
    expect(out).toBeNull();
    expect(m.recompute).not.toHaveBeenCalled();
  });
  it('skips the inline recompute when recompute=false and blanks a whitespace note', async () => {
    m.returningInsert.mockResolvedValue([{ id: 'b1' }]);
    await createReliabilityBaseline({ device, reason: 'reimaged', baselineAt: new Date(), note: '   ',
      source: 'manual', sourceRef: null, createdBy: 'u1', recompute: false });
    expect(m.recompute).not.toHaveBeenCalled();
    expect(m.insertValues.mock.calls[0]![0]).toMatchObject({ note: null });
  });

  // The nightly compute-org job scores a whole org in one transaction and holds
  // each device_reliability row lock until it finishes; a tech's marker write
  // must not wait that out on a pooled connection.
  it('runs the inline recompute in a savepoint with a bounded lock wait', async () => {
    m.returningInsert.mockResolvedValue([{ id: 'b1' }]);
    m.recompute.mockImplementation(async () => {
      expect(m.inSavepoint).toBe(true);
      expect(m.tighten).toHaveBeenCalled();
      return true;
    });
    await createReliabilityBaseline({ device, reason: 'reimaged', baselineAt: new Date(), note: null,
      source: 'manual', sourceRef: null, createdBy: 'u1', recompute: true });
    expect(m.recompute).toHaveBeenCalledWith('d1');
    expect(m.afterExit).toHaveLength(0);
  });
  it('defers the recompute to the worker when the inline one times out on a lock (create)', async () => {
    m.returningInsert.mockResolvedValue([{ id: 'b1' }]);
    m.selectRows.mockReturnValue([{ id: 'b1', baselineAt: new Date(), reason: 'reimaged', source: 'manual', note: null,
      beforeSnapshot: null, createdAt: new Date(), clearedAt: null, createdById: null, createdByName: null,
      clearedById: null, clearedByName: null }]);
    m.recompute.mockRejectedValue(lockTimeoutError());
    const out = await createReliabilityBaseline({ device, reason: 'reimaged', baselineAt: new Date(), note: null,
      source: 'manual', sourceRef: null, createdBy: 'u1', recompute: true });
    expect(out?.id).toBe('b1');
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.afterExit).toHaveLength(1);
    await m.afterExit[0]!();
    expect(m.enqueue).toHaveBeenCalledWith('d1', { dedupeKey: 'baseline-b1' });
  });
  it('defers the recompute to the worker when the inline one times out on a lock (clear)', async () => {
    m.returningUpdate.mockResolvedValue([{ id: 'b1' }]);
    m.recompute.mockRejectedValue(lockTimeoutError());
    await expect(clearReliabilityBaseline({ deviceId: 'd1', baselineId: 'b1', clearedBy: 'u1' })).resolves.toBe('cleared');
    expect(m.afterExit).toHaveLength(1);
    await m.afterExit[0]!();
    expect(m.enqueue).toHaveBeenCalledWith('d1', { dedupeKey: 'baseline-clear-b1' });
  });
  it('propagates a recompute failure that is not a lock timeout', async () => {
    m.returningUpdate.mockResolvedValue([{ id: 'b1' }]);
    m.recompute.mockRejectedValue(new Error('scorer exploded'));
    await expect(clearReliabilityBaseline({ deviceId: 'd1', baselineId: 'b1', clearedBy: 'u1' })).rejects.toThrow('scorer exploded');
    expect(m.afterExit).toHaveLength(0);
  });
});
