import { describe, it, expect } from 'vitest';
import { addMonthsClamped, computePeriod, periodIndexFor, nextBillingDate, isExpired } from './contractMath';

describe('addMonthsClamped', () => {
  it('preserves day-of-month when valid', () => {
    expect(addMonthsClamped('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonthsClamped('2026-01-15', 3)).toBe('2026-04-15');
  });
  it('clamps to last valid day on overflow', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29'); // leap year
  });
  it('rolls the year', () => {
    expect(addMonthsClamped('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonthsClamped('2026-06-01', 12)).toBe('2027-06-01');
  });
});

describe('computePeriod', () => {
  it('period 0 starts at start_date', () => {
    expect(computePeriod('2026-07-01', 1, 0)).toEqual({ periodStart: '2026-07-01', periodEnd: '2026-08-01' });
  });
  it('quarterly steps by 3 months', () => {
    expect(computePeriod('2026-01-15', 3, 1)).toEqual({ periodStart: '2026-04-15', periodEnd: '2026-07-15' });
  });
  it('annual steps by 12', () => {
    expect(computePeriod('2026-01-01', 12, 2)).toEqual({ periodStart: '2028-01-01', periodEnd: '2029-01-01' });
  });
});

describe('periodIndexFor', () => {
  it('returns the index of the period containing a date', () => {
    expect(periodIndexFor('2026-07-01', 1, '2026-07-01')).toBe(0);
    expect(periodIndexFor('2026-07-01', 1, '2026-07-20')).toBe(0);
    expect(periodIndexFor('2026-07-01', 1, '2026-08-01')).toBe(1);
    expect(periodIndexFor('2026-07-01', 1, '2026-09-15')).toBe(2);
  });
  it('clamps to 0 before the start', () => {
    expect(periodIndexFor('2026-07-01', 1, '2026-06-01')).toBe(0);
  });
});

describe('nextBillingDate', () => {
  it('advance fires at period start', () => {
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', periodIndex: 0 })).toBe('2026-07-01');
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', periodIndex: 1 })).toBe('2026-08-01');
  });
  it('arrears fires at period end', () => {
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'arrears', periodIndex: 0 })).toBe('2026-08-01');
  });
});

describe('isExpired', () => {
  it('true when period start is on/after end date', () => {
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2026-12-01' })).toBe(true);
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2027-01-01' })).toBe(true);
  });
  it('false when period start is before end date', () => {
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2026-11-01' })).toBe(false);
  });
  it('false when no end date', () => {
    expect(isExpired({ endDate: null, periodStart: '2099-01-01' })).toBe(false);
  });
});
