import { describe, expect, it } from 'vitest';
import { isPeriodClosed, lookbackStartIso, monthPeriod, previousClosedPeriod, utcStartIso } from './chargePeriods';

describe('chargePeriods: UTC calendar months (#7608)', () => {
  it('monthPeriod spans exactly one UTC month, across year ends and February', () => {
    expect(monthPeriod('2026-11-01')).toEqual({ periodStart: '2026-11-01', periodEnd: '2026-12-01' });
    expect(monthPeriod('2026-12-01')).toEqual({ periodStart: '2026-12-01', periodEnd: '2027-01-01' });
    expect(monthPeriod('2028-02-01')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-03-01' });
  });
  it('rejects a non-month-start', () => {
    expect(() => monthPeriod('2026-11-15')).toThrow();
    expect(() => monthPeriod('2026-13-01')).toThrow();
  });
  it('a period closes one hour after its UTC end', () => {
    const p = monthPeriod('2026-11-01');
    expect(isPeriodClosed(p, new Date('2026-12-01T00:59:59Z'))).toBe(false);
    expect(isPeriodClosed(p, new Date('2026-12-01T01:00:00Z'))).toBe(true);
  });
  it('previousClosedPeriod is last month once the grace has passed, else the month before', () => {
    expect(previousClosedPeriod(new Date('2026-12-01T05:28:00Z')).periodStart).toBe('2026-11-01');
    expect(previousClosedPeriod(new Date('2026-12-01T00:30:00Z')).periodStart).toBe('2026-10-01');
    expect(previousClosedPeriod(new Date('2027-01-15T12:00:00Z')).periodStart).toBe('2026-12-01');
  });
  it('lookback is 92 days before the period start, at UTC midnight', () => {
    expect(lookbackStartIso(monthPeriod('2026-11-01'))).toBe('2026-08-01T00:00:00.000Z');
    expect(utcStartIso('2026-12-01')).toBe('2026-12-01T00:00:00.000Z');
  });
});
