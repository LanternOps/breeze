import { describe, expect, it } from 'vitest';
import {
  allocateBlockCoverage, isHeldByBlock,
  type BlockPeriodCoverage, type HourBlockHoldWindow,
} from './hourBlockWindows';

const win = (start: string, end: string | null): HourBlockHoldWindow => ({
  start: new Date(start),
  end: end === null ? null : new Date(end),
  contractLineId: 'line-1',
});

describe('isHeldByBlock', () => {
  const windows = [win('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z')];

  it('holds an entry that ended inside the window', () => {
    expect(isHeldByBlock(new Date('2026-12-10T13:00:00Z'), windows)).toBe(true);
  });

  it('start is inclusive, end is exclusive (a boundary entry belongs to exactly one period)', () => {
    expect(isHeldByBlock(new Date('2026-12-01T00:00:00Z'), windows)).toBe(true);
    expect(isHeldByBlock(new Date('2027-01-01T00:00:00Z'), windows)).toBe(false);
  });

  it('does not hold an entry from before the window (a late entry in a closed period)', () => {
    expect(isHeldByBlock(new Date('2026-11-30T23:59:59Z'), windows)).toBe(false);
  });

  it('a window with no end holds everything from its start on', () => {
    expect(isHeldByBlock(new Date('2031-01-01T00:00:00Z'), [win('2026-12-01T00:00:00Z', null)])).toBe(true);
  });

  it('never holds a running entry (no ended_at) or when there are no windows', () => {
    expect(isHeldByBlock(null, windows)).toBe(false);
    expect(isHeldByBlock(new Date('2026-12-10T13:00:00Z'), [])).toBe(false);
  });
});

describe('allocateBlockCoverage (cap at the period entitlement)', () => {
  const dec = (overageMinutes: number): BlockPeriodCoverage[] => [
    { start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z'), overageMinutes },
  ];
  const a = { key: 'a', endedAt: new Date('2026-12-05T10:00:00Z'), minutes: 120 };
  const b = { key: 'b', endedAt: new Date('2026-12-10T10:00:00Z'), minutes: 90 };

  it('under the cap (no overage): every minute is covered, none is over', () => {
    const out = allocateBlockCoverage([a, b], dec(0));
    expect(out.get('a')).toEqual({ covered: 120, over: 0 });
    expect(out.get('b')).toEqual({ covered: 90, over: 0 });
  });

  it('over the cap: the overage lands on the LATEST entries, splitting the boundary entry', () => {
    const out = allocateBlockCoverage([a, b], dec(60));
    expect(out.get('b')).toEqual({ covered: 30, over: 60 });
    expect(out.get('a')).toEqual({ covered: 120, over: 0 });
  });

  it('an overage larger than the latest entry spills into the earlier one', () => {
    const out = allocateBlockCoverage([a, b], dec(100));
    expect(out.get('b')).toEqual({ covered: 0, over: 90 });
    expect(out.get('a')).toEqual({ covered: 110, over: 10 });
  });

  it('covered + over always equals the entry minutes, and over sums to the overage', () => {
    const out = allocateBlockCoverage([a, b], dec(75));
    let over = 0;
    for (const e of [a, b]) {
      const r = out.get(e.key)!;
      expect(r.covered + r.over).toBe(e.minutes);
      over += r.over;
    }
    expect(over).toBe(75);
  });

  it('periods are independent: a closed period with overage does not touch the open one', () => {
    const periods: BlockPeriodCoverage[] = [
      { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z'), overageMinutes: 30 },
      ...dec(0),
    ];
    const nov = { key: 'n', endedAt: new Date('2026-11-20T10:00:00Z'), minutes: 60 };
    const out = allocateBlockCoverage([nov, b], periods);
    expect(out.get('n')).toEqual({ covered: 30, over: 30 });
    expect(out.get('b')).toEqual({ covered: 90, over: 0 });
  });

  it('an entry that fits no known period is treated as fully covered (never invents overage)', () => {
    const out = allocateBlockCoverage([{ key: 'x', endedAt: new Date('2030-01-01T00:00:00Z'), minutes: 45 }], dec(50));
    expect(out.get('x')).toEqual({ covered: 45, over: 0 });
  });
});
