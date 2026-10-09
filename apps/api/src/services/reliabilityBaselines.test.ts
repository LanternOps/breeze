import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  returningInsert: vi.fn(), returningUpdate: vi.fn(), selectRows: vi.fn(),
  scoreAsOf: vi.fn(), recompute: vi.fn(), active: vi.fn(),
  insertValues: vi.fn(),
}));
vi.mock('../db', () => {
  const selectChain: any = {};
  for (const k of ['from', 'leftJoin', 'where', 'orderBy']) selectChain[k] = vi.fn(() => selectChain);
  selectChain.limit = vi.fn(() => m.selectRows());
  selectChain.then = (res: any, rej: any) => Promise.resolve(m.selectRows()).then(res, rej);
  return { db: {
    insert: vi.fn(() => ({ values: (v: unknown) => { m.insertValues(v); return { onConflictDoNothing: () => ({ returning: m.returningInsert }) }; } })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: m.returningUpdate }) }) })),
    select: vi.fn(() => selectChain),
  } };
});
vi.mock('./reliabilityScoring', () => ({ scoreDeviceReliabilityAsOf: m.scoreAsOf, computeAndPersistDeviceReliability: m.recompute }));
vi.mock('./reliabilityBaselineQueries', () => ({ getActiveReliabilityBaseline: m.active }));

import { computeBeforeSnapshot, createReliabilityBaseline } from './reliabilityBaselines';

const device = { id: 'd1', orgId: 'o1', deviceRole: 'workstation', enrolledAt: null };
const values = { reliabilityScore: 50, uptimeScore: 100, crashScore: 10, hangScore: 100, serviceFailureScore: 100, hardwareErrorScore: 100,
  crashCount30d: 4, hangCount30d: 0, serviceFailureCount30d: 0, hardwareErrorCount30d: 0 };

describe('reliabilityBaselines service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.active.mockResolvedValue(null);
    m.scoreAsOf.mockResolvedValue({ values, coverageDays: 30, weightProfile: 'workstation' });
    m.selectRows.mockReturnValue([]);
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
});
