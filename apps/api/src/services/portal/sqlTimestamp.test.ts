import { describe, expect, it } from 'vitest';
import { dateFromSqlValue, sqlTimestamp } from './sqlTimestamp';
import { withHostTimeZone } from '../../testUtils/hostTimeZone';

describe('sqlTimestamp', () => {
  it('passes Date instances through', () => {
    const date = new Date('2026-09-02T09:00:00Z');
    expect(sqlTimestamp(date)).toBe(date);
  });

  it('parses postgres timestamptz text (postgres-js form)', () => {
    expect(sqlTimestamp('2026-09-02 09:00:00+00')?.toISOString())
      .toBe('2026-09-02T09:00:00.000Z');
    expect(sqlTimestamp('2026-09-02 03:00:00-06')?.toISOString())
      .toBe('2026-09-02T09:00:00.000Z');
    expect(sqlTimestamp('2026-09-02T09:00:00.000Z')?.toISOString())
      .toBe('2026-09-02T09:00:00.000Z');
  });

  it('reads a zone-less timestamp (timestamp WITHOUT time zone) as UTC, like the Drizzle column mapper', () => {
    expect(sqlTimestamp('2026-09-01 00:00:00')?.toISOString())
      .toBe('2026-09-01T00:00:00.000Z');
    expect(sqlTimestamp('2026-09-01 00:00:00.123')?.toISOString())
      .toBe('2026-09-01T00:00:00.123Z');
  });

  it('maps null and undefined to null', () => {
    expect(sqlTimestamp(null)).toBeNull();
    expect(sqlTimestamp(undefined)).toBeNull();
  });

  it('throws on garbage instead of returning an Invalid Date', () => {
    expect(() => sqlTimestamp('not a timestamp')).toThrow(TypeError);
  });
});

describe('dateFromSqlValue', () => {
  const HOSTS = ['UTC', 'America/Denver', 'Asia/Tokyo'] as const;

  it.each(HOSTS)('reads offsetless date-time text as UTC on a %s host', (zone) => {
    withHostTimeZone(zone, () => {
      expect(dateFromSqlValue('2026-08-25 18:34:15.123').toISOString()).toBe('2026-08-25T18:34:15.123Z');
      expect(dateFromSqlValue('2026-08-25 18:34:15').toISOString()).toBe('2026-08-25T18:34:15.000Z');
      expect(dateFromSqlValue('2026-08-25T18:34:15.123456').toISOString()).toBe('2026-08-25T18:34:15.123Z');
    });
  });

  it.each(HOSTS)('matches new Date(value) for every other input on a %s host', (zone) => {
    withHostTimeZone(zone, () => {
      for (const value of [
        '2026-08-25 18:34:15+00',
        '2026-08-25 12:34:15.5-06',
        '2026-08-25 23:49:15+05:30',
        '2026-08-25T18:34:15.123Z',
        '2026-08-25',
      ]) {
        expect(dateFromSqlValue(value).getTime(), value).toBe(new Date(value).getTime());
      }
      const date = new Date('2026-08-25T18:34:15.123Z');
      expect(dateFromSqlValue(date)).toBe(date);
      expect(Number.isNaN(dateFromSqlValue('not a timestamp').getTime())).toBe(true);
    });
  });
});
