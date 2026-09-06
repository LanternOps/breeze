import { describe, expect, it } from 'vitest';
import { sqlTimestamp } from './sqlTimestamp';

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
