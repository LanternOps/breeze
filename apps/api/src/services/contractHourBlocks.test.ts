import { describe, expect, it } from 'vitest';
import {
  HOUR_BLOCK_CLOSE_CAP, computePeriodMath, entryHours, selectClosablePeriods, sumEntryHours,
  type HourBlockLineSpec,
} from './contractHourBlocks';
import { applyAllowance } from './contractAllowance';

const spec = (o: Partial<HourBlockLineSpec> = {}): HourBlockLineSpec => ({
  includedQuantity: '10.00', overageUnitPrice: '150.00', rolloverPolicy: 'none', rolloverCapHours: null, ...o,
});

describe('entryHours / sumEntryHours', () => {
  it.each([[0, 0], [20, 0.33], [30, 0.5], [40, 0.67], [60, 1], [90, 1.5], [125, 2.08]])(
    '%d min -> %d h', (m, h) => expect(entryHours(m)).toBe(h));
  it('rounds each entry before summing (20 min x 3 = 0.99, not 1.00)', () => {
    expect(sumEntryHours([20, 20, 20])).toBe(0.99);
  });
  it('has no float drift over many entries', () => {
    expect(sumEntryHours(Array(300).fill(20))).toBe(99); // 300 x 0.33
  });
  it('rejects negative minutes', () => {
    expect(() => entryHours(-1)).toThrow(/minutes must be >= 0/);
  });
});

describe('computePeriodMath', () => {
  it.each`
    policy             | cap        | carriedIn | consumed | opening | overage | carriedOut
    ${'none'}          | ${null}    | ${0}      | ${0}     | ${10}   | ${0}    | ${0}
    ${'none'}          | ${null}    | ${0}      | ${6.5}   | ${10}   | ${0}    | ${0}
    ${'none'}          | ${null}    | ${0}      | ${10}    | ${10}   | ${0}    | ${0}
    ${'none'}          | ${null}    | ${0}      | ${12.33} | ${10}   | ${2.33} | ${0}
    ${'carry_forward'} | ${null}    | ${0}      | ${6.5}   | ${10}   | ${0}    | ${3.5}
    ${'carry_forward'} | ${null}    | ${3.5}    | ${12}    | ${13.5} | ${0}    | ${1.5}
    ${'carry_forward'} | ${'2.00'}  | ${0}      | ${6.5}   | ${10}   | ${0}    | ${2}
    ${'carry_forward'} | ${'2.00'}  | ${2}      | ${15}    | ${12}   | ${3}    | ${0}
  `('$policy cap=$cap in=$carriedIn used=$consumed', ({ policy, cap, carriedIn, consumed, opening, overage, carriedOut }) => {
    const m = computePeriodMath(spec({ rolloverPolicy: policy, rolloverCapHours: cap }), carriedIn, consumed);
    expect(m).toEqual({
      includedHours: 10, carriedInHours: carriedIn, openingHours: opening,
      consumedHours: consumed, overageHours: overage, carriedOutHours: carriedOut,
    });
  });
  it('agrees with applyAllowance(single_block) on the overage split', () => {
    const m = computePeriodMath(spec(), 0, 12.33);
    const r = applyAllowance(12.33, { includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00' }, 'single_block');
    expect(r.billed).toBe(1);
    expect(Math.round(r.overage * 100) / 100).toBe(m.overageHours);
  });
});

describe('selectClosablePeriods', () => {
  const base = {
    contractStartDate: '2026-01-01', intervalMonths: 1, firstPeriodStart: '2026-01-01',
    retiredAt: null, closedPeriodStarts: new Set<string>(),
  };
  /** Claims generated at 06:00 UTC on each period's start day (the worker's run time). */
  const claimed = (...s: string[]) => s.map((periodStart) => ({ periodStart, generatedAt: new Date(`${periodStart}T06:00:00Z`) }));

  it('closes ended, claimed periods earliest first', () => {
    const r = selectClosablePeriods({ ...base, claims: claimed('2026-01-01', '2026-02-01', '2026-03-01'), todayISO: '2026-03-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-01-01', '2026-02-01']);
    expect(r).toMatchObject({ truncated: false, blockedBy: null });
  });
  it('a period ending today is ended (half-open)', () => {
    const r = selectClosablePeriods({ ...base, claims: claimed('2026-01-01'), todayISO: '2026-02-01' });
    expect(r.periods.map((p) => p.periodEnd)).toEqual(['2026-02-01']);
  });
  it('skips unclaimed periods (pause gap) without blocking', () => {
    const r = selectClosablePeriods({ ...base, claims: claimed('2026-01-01', '2026-04-01'), todayISO: '2026-06-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-01-01', '2026-04-01']);
  });
  it('never closes a period before the first block period', () => {
    const r = selectClosablePeriods({ ...base, firstPeriodStart: '2026-03-01', claims: claimed('2026-01-01', '2026-02-01', '2026-03-01'), todayISO: '2026-04-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-03-01']);
  });
  it('skips already-closed periods', () => {
    const r = selectClosablePeriods({ ...base, closedPeriodStarts: new Set(['2026-01-01']), claims: claimed('2026-01-01', '2026-02-01'), todayISO: '2026-03-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-02-01']);
  });
  it('a retired line closes only periods claimed while it was live', () => {
    const r = selectClosablePeriods({ ...base, retiredAt: new Date('2026-02-15T10:00:00Z'), claims: claimed('2026-01-01', '2026-02-01', '2026-03-01'), todayISO: '2026-05-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-01-01', '2026-02-01']);
  });
  it('expiry on the claim day: the final period claimed and retired in one transaction still closes', () => {
    // generateDueInvoice claims 2026-03-01 and retires the line in the same transaction:
    // generated_at and hour_block_retired_at are both now() — equal, so the claim counts.
    const at = new Date('2026-03-01T06:00:00Z');
    const r = selectClosablePeriods({ ...base, retiredAt: at, claims: [{ periodStart: '2026-03-01', generatedAt: at }], todayISO: '2026-04-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-03-01']);
  });
  it('arrears retire mid-period: the period claimed AFTER retirement (no fee billed) never closes', () => {
    const r = selectClosablePeriods({ ...base, retiredAt: new Date('2026-06-20T10:00:00Z'),
      claims: [{ periodStart: '2026-06-01', generatedAt: new Date('2026-07-01T06:00:00Z') }], contractStartDate: '2026-06-01', firstPeriodStart: '2026-06-01', todayISO: '2026-07-02' });
    expect(r.periods).toEqual([]);
  });
  it('stops at the cap and reports truncation', () => {
    const starts = Array.from({ length: 15 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}-01`).slice(0, 12)
      .concat(['2026-01-01', '2026-02-01', '2026-03-01']);
    const r = selectClosablePeriods({ ...base, contractStartDate: '2025-01-01', firstPeriodStart: '2025-01-01', claims: starts.map((periodStart) => ({ periodStart, generatedAt: new Date(`${periodStart}T06:00:00Z`) })), todayISO: '2026-06-01' });
    expect(r.periods).toHaveLength(HOUR_BLOCK_CLOSE_CAP);
    expect(r.truncated).toBe(true);
    expect(r.periods[0]!.periodStart).toBe('2025-01-01');
  });
  it('works for quarterly intervals and month-end starts', () => {
    const r = selectClosablePeriods({ ...base, contractStartDate: '2026-01-31', firstPeriodStart: '2026-01-31', intervalMonths: 3, claims: claimed('2026-01-31'), todayISO: '2026-05-01' });
    expect(r.periods).toEqual([{ index: 0, periodStart: '2026-01-31', periodEnd: '2026-04-30' }]);
  });
});
