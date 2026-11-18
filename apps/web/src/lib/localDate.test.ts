import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { endOfLocalDayIso, localDateInputValue } from './localDate';

describe('localDateInputValue', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Denver';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });
  afterEach(() => vi.useRealTimers());

  it('returns the local calendar day, not the UTC day, in the evening', () => {
    vi.useFakeTimers();
    // 23:30 MDT on 2026-10-18 == 05:30Z on 10-19
    vi.setSystemTime(new Date('2026-10-19T05:30:00Z'));
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-19');
    expect(localDateInputValue()).toBe('2026-10-18');
  });

  it('accepts an explicit date and zero-pads', () => {
    expect(localDateInputValue(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });

  it('endOfLocalDayIso returns the last millisecond of the local day (#9654)', () => {
    // MDT (UTC-6), MST (UTC-7) on a leap day, and the spring-forward day.
    expect(endOfLocalDayIso('2099-06-30')).toBe('2099-07-01T05:59:59.999Z');
    expect(endOfLocalDayIso('2028-02-29')).toBe('2028-03-01T06:59:59.999Z');
    expect(endOfLocalDayIso('2026-03-08')).toBe('2026-03-09T05:59:59.999Z');
  });

  it('endOfLocalDayIso rejects malformed and non-existent dates', () => {
    for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '31/12/2026', '2026-1-5', '']) {
      expect(endOfLocalDayIso(bad)).toBeNull();
    }
  });
});
