import { describe, it, expect, beforeEach, vi } from 'vitest';

const inserted: unknown[] = [];
const updates: Array<{ set: Record<string, unknown> }> = [];

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../sentry', () => ({ captureException }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        inserted.push(v);
        return { returning: vi.fn().mockResolvedValue([{ id: `new-${inserted.length}` }]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((s: Record<string, unknown>) => {
        updates.push({ set: s });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  },
}));

import { db } from '../../db';
import { persistSignals } from './persistence';
import type { ComputedSignal } from './types';

const now = new Date('2026-07-15T12:00:00Z');

function mockOpenRows(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
  } as never);
}

function signal(overrides: Partial<ComputedSignal>): ComputedSignal {
  return { partnerId: 'p1', signalKey: 'rmm.consumer_devices', score: 80, severity: 'alert', evidence: {}, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  updates.length = 0;
  captureException.mockClear();
});

describe('persistSignals', () => {
  it('inserts new fired signals and notifies alerts only', async () => {
    mockOpenRows([]);
    const { toNotify } = await persistSignals(
      [signal({}), signal({ signalKey: 'rmm.enrollment_velocity', score: 45, severity: 'watch' })],
      now,
      new Set(['p1']),
    );
    expect(inserted).toHaveLength(2);
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]!.signalKey).toBe('rmm.consumer_devices');
  });

  it('updates an existing open row without re-notifying a delivered alert', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: null, deliveredAt: new Date() }]);
    const { toNotify } = await persistSignals([signal({})], now, new Set(['p1']));
    expect(inserted).toHaveLength(0);
    expect(updates.length).toBeGreaterThan(0);
    expect(toNotify).toHaveLength(0);
    expect(updates[0]!.set).not.toHaveProperty('firstFiredAt');
    expect(updates[0]!.set).not.toHaveProperty('resolvedAt');
  });

  it('notifies on escalation to alert (open watch row, never delivered)', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    const { toNotify } = await persistSignals([signal({ severity: 'alert' })], now, new Set(['p1']));
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]!.rowId).toBe('row1');
  });

  it('never notifies acknowledged rows', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: new Date(), deliveredAt: null }]);
    const { toNotify } = await persistSignals([signal({})], now, new Set(['p1']));
    expect(toNotify).toHaveLength(0);
  });

  it('resolves open rows that did not fire this sweep, for an evaluated partner', async () => {
    mockOpenRows([{ id: 'stale', partnerId: 'p9', signalKey: 'rmm.enrollment_velocity', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    await persistSignals([], now, new Set(['p9']));
    expect(updates.some((u) => u.set.resolvedAt instanceof Date)).toBe(true);
  });

  it('dedupes duplicate (partner, signal) entries within one batch, last write wins', async () => {
    mockOpenRows([]);
    const { toNotify } = await persistSignals(
      [signal({ score: 50, severity: 'watch' }), signal({ score: 90, severity: 'alert' })],
      now,
      new Set(['p1']),
    );
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { score: number }).score).toBe(90);
    expect(toNotify).toHaveLength(1);
  });

  it('leaves an open heuristic row untouched when its partner was NOT evaluated this sweep (scope exit, not evidence)', async () => {
    mockOpenRows([{ id: 'stale', partnerId: 'p9', signalKey: 'rmm.enrollment_velocity', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    await persistSignals([], now, new Set(['p1']));
    expect(updates.some((u) => u.set.resolvedAt instanceof Date)).toBe(false);
  });

  it('resolves an open invariant.* row that did not fire this sweep even when its partner is not in the evaluated set', async () => {
    mockOpenRows([{ id: 'stale-invariant', partnerId: 'p9', signalKey: 'invariant.something', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    await persistSignals([], now, new Set(['p1']));
    expect(updates.some((u) => u.set.resolvedAt instanceof Date)).toBe(true);
  });

  it('still notifies a decayed-but-undelivered alert (open row was alert, this sweep scored it watch)', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: null, deliveredAt: null }]);
    const { toNotify } = await persistSignals(
      [signal({ severity: 'watch', score: 45 })],
      now,
      new Set(['p1']),
    );
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]!.rowId).toBe('row1');
  });

  it('does not re-notify a decayed row that was already delivered', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: null, deliveredAt: new Date() }]);
    const { toNotify } = await persistSignals(
      [signal({ severity: 'watch', score: 45 })],
      now,
      new Set(['p1']),
    );
    expect(toNotify).toHaveLength(0);
  });

  it('logs and captures an exception when INSERT returns no row', async () => {
    mockOpenRows([]);
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    } as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { toNotify } = await persistSignals([signal({})], now, new Set(['p1']));
    expect(toNotify).toHaveLength(0);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('captures an exception (but still resolves) when stale-resolving an undelivered alert-severity row', async () => {
    mockOpenRows([{ id: 'stale-alert', partnerId: 'p9', signalKey: 'rmm.enrollment_velocity', severity: 'alert', acknowledgedAt: null, deliveredAt: null }]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await persistSignals([], now, new Set(['p9']));
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.set.resolvedAt instanceof Date)).toBe(true);
    errSpy.mockRestore();
  });

  it('does not capture an exception when stale-resolving a delivered alert-severity row', async () => {
    mockOpenRows([{ id: 'stale-alert', partnerId: 'p9', signalKey: 'rmm.enrollment_velocity', severity: 'alert', acknowledgedAt: null, deliveredAt: new Date() }]);
    await persistSignals([], now, new Set(['p9']));
    expect(captureException).not.toHaveBeenCalled();
    expect(updates.some((u) => u.set.resolvedAt instanceof Date)).toBe(true);
  });
});

describe('markDelivered', () => {
  it('marks rows as delivered with the given date', async () => {
    const { markDelivered } = await import('./persistence');
    updates.length = 0;
    await markDelivered(['r1', 'r2'], now);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.deliveredAt).toEqual(now);
  });

  it('does not call update when rowIds is empty', async () => {
    const { markDelivered } = await import('./persistence');
    updates.length = 0;
    await markDelivered([], now);
    expect(updates).toHaveLength(0);
  });
});
