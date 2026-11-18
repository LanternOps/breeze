import { describe, it, expect, vi, afterEach } from 'vitest';
import { money, shortDate } from './format';
import { formatRelativeTime } from './utils';

describe('money', () => {
  it('formats strings and numbers as currency', () => {
    expect(money('1875.00', 'USD')).toBe('$1,875.00');
    expect(money(640, 'USD')).toBe('$640.00');
  });

  it('never renders a broken amount as $0.00', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(money('NaN', 'USD')).toBe('—');
    expect(money(null as unknown as string, 'USD')).toBe('—');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('falls back to a plain figure on an unknown currency code', () => {
    expect(money('10.50', 'NOTREAL')).toBe('10.50 NOTREAL');
  });
});

describe('shortDate', () => {
  it('keeps a date-only string on its calendar day (no timezone shift)', () => {
    expect(shortDate('2026-08-15')).toBe(new Date(2026, 7, 15).toLocaleDateString());
  });
  // #10291: an instant formats in the zone it is given, so an SSR render (UTC
  // container) and a hydrated one (the customer's browser) print the same day.
  // Runtime-zone independent: run under TZ=America/Los_Angeles and Europe/Berlin.
  it('formats a timestamp as the calendar day in the given zone, not the runtime zone', () => {
    const endOfNov9Denver = '2026-11-10T06:59:59.999Z';
    expect(shortDate(endOfNov9Denver, 'America/Denver')).toBe(new Date(2026, 10, 9).toLocaleDateString());
    expect(shortDate(endOfNov9Denver, 'Europe/Berlin')).toBe(new Date(2026, 10, 10).toLocaleDateString());
  });
  it('keeps a date-only string on its calendar day even when a zone is given', () => {
    expect(shortDate('2026-08-15', 'America/Los_Angeles')).toBe(new Date(2026, 7, 15).toLocaleDateString());
    expect(shortDate('2026-08-15', 'Pacific/Kiritimati')).toBe(new Date(2026, 7, 15).toLocaleDateString());
  });
  it('renders a dash for nothing and passes garbage through rather than "Invalid Date"', () => {
    expect(shortDate(null)).toBe('—');
    expect(shortDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatRelativeTime (customer phrasing)', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [30 * 1000, 'Just now'],
    [5 * 60 * 1000, '5 minutes ago'],
    [1 * 60 * 1000, '1 minute ago'],
    [-60 * 1000, 'Just now'], // clock skew in the future reads as now
  ])('%d ms ago → %s', (ms, expected) => {
    vi.useFakeTimers().setSystemTime(new Date('2026-08-21T12:00:00'));
    expect(formatRelativeTime(new Date(Date.now() - ms))).toBe(expected);
  });

  it('says Yesterday across midnight even when fewer than 24 hours passed', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-08-21T07:00:00'));
    expect(formatRelativeTime(new Date('2026-08-20T23:00:00'))).toBe('Yesterday');
  });

  it('returns an empty string for an unparseable value', () => {
    expect(formatRelativeTime('garbage')).toBe('');
  });
});
