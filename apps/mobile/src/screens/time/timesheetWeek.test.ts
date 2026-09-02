import { describe, it, expect } from 'vitest';

import { dayLabel, daysOfWeek, shiftWeek, weekRangeLabel, weekStartFor } from './timesheetWeek';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

describe('weekStartFor', () => {
  it('returns the Monday of the week containing the date', () => {
    // 2026-08-30 is a Sunday; its week began Monday 2026-08-24.
    expect(weekStartFor(new Date(2026, 7, 30))).toBe('2026-08-24');
    expect(weekStartFor(new Date(2026, 7, 26))).toBe('2026-08-24');
  });

  it('returns a Monday unchanged', () => {
    expect(weekStartFor(new Date(2026, 7, 24))).toBe('2026-08-24');
  });

  it('emits a date-only value, never a full ISO timestamp', () => {
    // The server treats weekStart as a calendar date. Sending
    // "2026-08-24T00:00:00.000Z" shifts the day boundary by the phone's offset
    // and silently moves entries between weeks.
    expect(weekStartFor(new Date(2026, 7, 30, 23, 45))).toMatch(DATE_ONLY);
  });

  it('uses the local calendar day, not UTC', () => {
    // 23:45 local on a Sunday is already Monday in UTC for eastward offsets.
    // Deriving the week from UTC would jump a whole week forward.
    expect(weekStartFor(new Date(2026, 7, 30, 23, 45))).toBe('2026-08-24');
    expect(weekStartFor(new Date(2026, 7, 31, 0, 15))).toBe('2026-08-31');
  });
});

describe('shiftWeek', () => {
  it('steps a whole week in either direction', () => {
    expect(shiftWeek('2026-08-24', -1)).toBe('2026-08-17');
    expect(shiftWeek('2026-08-24', 1)).toBe('2026-08-31');
  });

  it('crosses month and year boundaries', () => {
    expect(shiftWeek('2026-01-04', -1)).toBe('2025-12-28');
    expect(shiftWeek('2025-12-29', 1)).toBe('2026-01-05');
  });
});

describe('daysOfWeek', () => {
  it('returns the seven date-only days from the week start', () => {
    expect(daysOfWeek('2026-08-24')).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
    ]);
  });
});

describe('dayLabel', () => {
  it('labels a date-only string with a fixed weekday and month name', () => {
    // Deliberately not toLocaleDateString: its output varies by device locale
    // and by JS engine (Hermes ships a reduced ICU), which makes the header
    // unpredictable across the fleet.
    expect(dayLabel('2026-08-24')).toBe('Mon 24 Aug');
    expect(dayLabel('2026-08-30')).toBe('Sun 30 Aug');
  });
});

describe('weekRangeLabel', () => {
  it('names both ends of the week', () => {
    expect(weekRangeLabel('2026-08-24')).toBe('24 Aug – 30 Aug 2026');
  });
});
