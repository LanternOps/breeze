import { describe, expect, it } from 'vitest';

import { formatNextOccurrence, isDue, lastOccurrenceKey, nextOccurrence } from './reportSchedule';

describe('lastOccurrenceKey', () => {
  it('daily: before today\'s time uses yesterday', () => {
    const now = new Date('2026-07-01T09:00:00Z'); // 04:00 America/Chicago (CDT, UTC-5)
    const key = lastOccurrenceKey(now, 'daily', { time: '09:00' }, 'America/Chicago');
    expect(key).toBe(202606300900);
  });

  it('weekly: wednesday now, target monday', () => {
    const now = new Date('2026-07-01T14:00:00Z'); // Wednesday UTC
    expect(lastOccurrenceKey(now, 'weekly', { time: '09:00', day: 'monday' }, 'UTC')).toBe(202606290900);
  });

  it('monthly: clamps to month length', () => {
    const marchFirst = new Date('2026-03-01T12:00:00Z');
    const key = lastOccurrenceKey(marchFirst, 'monthly', { time: '09:00', date: '31' }, 'UTC');
    expect(key).toBe(202602280900); // Feb 2026 has 28 days
  });
});

describe('nextOccurrence', () => {
  it('daily: time later today stays on today', () => {
    const now = new Date('2026-07-01T14:00:00Z'); // 14:00 UTC
    const occ = nextOccurrence(now, 'daily', { time: '16:00' }, 'UTC');
    expect(occ).toEqual({ y: 2026, m: 7, d: 1, hh: 16, mm: 0 });
  });

  it('daily: time already passed today rolls to tomorrow', () => {
    const now = new Date('2026-07-01T14:00:00Z'); // 14:00 UTC
    const occ = nextOccurrence(now, 'daily', { time: '09:00' }, 'UTC');
    expect(occ).toEqual({ y: 2026, m: 7, d: 2, hh: 9, mm: 0 });
  });

  it('weekly: wraps forward to next target weekday', () => {
    const now = new Date('2026-07-01T14:00:00Z'); // Wednesday UTC
    const occ = nextOccurrence(now, 'weekly', { time: '09:00', day: 'monday' }, 'UTC');
    expect(occ).toEqual({ y: 2026, m: 7, d: 6, hh: 9, mm: 0 });
  });

  it('monthly: clamps date to month length', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const occ = nextOccurrence(now, 'monthly', { time: '09:00', date: '31' }, 'UTC');
    expect(occ).toEqual({ y: 2026, m: 6, d: 30, hh: 9, mm: 0 });
  });

  it('monthly: wraps into next year', () => {
    const now = new Date('2026-12-20T12:00:00Z');
    const occ = nextOccurrence(now, 'monthly', { time: '09:00', date: '1' }, 'UTC');
    expect(occ).toEqual({ y: 2027, m: 1, d: 1, hh: 9, mm: 0 });
  });
});

describe('formatNextOccurrence', () => {
  it('formats with weekday', () => {
    expect(formatNextOccurrence({ y: 2026, m: 7, d: 6, hh: 9, mm: 0 }, { weekday: true })).toBe(
      'Mon, Jul 6, 9:00 AM',
    );
  });

  it('formats without weekday by default', () => {
    expect(formatNextOccurrence({ y: 2026, m: 7, d: 6, hh: 9, mm: 0 })).toBe('Jul 6, 9:00 AM');
  });
});

describe('isDue', () => {
  it('is due when never generated', () => {
    const occurrence = lastOccurrenceKey(new Date('2026-07-01T09:00:00Z'), 'daily', { time: '09:00' }, 'UTC');
    expect(isDue(null, occurrence, 'UTC')).toBe(true);
  });

  it('is not due when generated at/after the occurrence', () => {
    const occurrence = lastOccurrenceKey(new Date('2026-07-01T09:00:00Z'), 'daily', { time: '09:00' }, 'UTC');
    expect(isDue(new Date('2026-07-01T09:00:00Z'), occurrence, 'UTC')).toBe(false);
  });
});
