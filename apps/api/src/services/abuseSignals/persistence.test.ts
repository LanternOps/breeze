import { describe, it, expect, beforeEach, vi } from 'vitest';

const inserted: unknown[] = [];
const updates: Array<{ set: Record<string, unknown> }> = [];

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
});

describe('persistSignals', () => {
  it('inserts new fired signals and notifies alerts only', async () => {
    mockOpenRows([]);
    const { toNotify } = await persistSignals(
      [signal({}), signal({ signalKey: 'rmm.enrollment_velocity', score: 45, severity: 'watch' })],
      now,
    );
    expect(inserted).toHaveLength(2);
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]!.signalKey).toBe('rmm.consumer_devices');
  });

  it('updates an existing open row without re-notifying a delivered alert', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: null, deliveredAt: new Date() }]);
    const { toNotify } = await persistSignals([signal({})], now);
    expect(inserted).toHaveLength(0);
    expect(updates.length).toBeGreaterThan(0);
    expect(toNotify).toHaveLength(0);
  });

  it('notifies on escalation to alert (open watch row, never delivered)', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    const { toNotify } = await persistSignals([signal({ severity: 'alert' })], now);
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0]!.rowId).toBe('row1');
  });

  it('never notifies acknowledged rows', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: new Date(), deliveredAt: null }]);
    const { toNotify } = await persistSignals([signal({})], now);
    expect(toNotify).toHaveLength(0);
  });

  it('resolves open rows that did not fire this sweep', async () => {
    mockOpenRows([{ id: 'stale', partnerId: 'p9', signalKey: 'rmm.enrollment_velocity', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    await persistSignals([], now);
    expect(updates.some((u) => u.set.resolvedAt instanceof Date)).toBe(true);
  });
});
