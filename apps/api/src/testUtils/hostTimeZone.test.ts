import { describe, expect, it } from 'vitest';
import { withHostTimeZone, zoneOffsetMinutes } from './hostTimeZone';

/**
 * Guards the helper itself. Every host-zone test built on it is only as good
 * as the switch it performs, so the switch and the restore are asserted
 * directly, in whatever zone the runner happens to use.
 */
describe('withHostTimeZone', () => {
  const SUMMER = Date.UTC(2026, 7, 25, 18, 34, 15, 123);
  const WINTER = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('puts the process west of UTC for America/Denver, DST included', () => {
    withHostTimeZone('America/Denver', () => {
      expect(new Date(SUMMER).getTimezoneOffset()).toBe(360);
      expect(new Date(WINTER).getTimezoneOffset()).toBe(420);
      // An offsetless string is read as local time: this is what a raw
      // `new Date('2026-08-25 18:34:15.123')` does on such a host.
      expect(new Date('2026-08-25 18:34:15.123').getTime()).toBe(SUMMER + 360 * 60_000);
    });
  });

  it('puts the process east of UTC for Asia/Tokyo', () => {
    withHostTimeZone('Asia/Tokyo', () => {
      expect(new Date(SUMMER).getTimezoneOffset()).toBe(-540);
      expect(new Date('2026-08-25 18:34:15.123').getTime()).toBe(SUMMER - 540 * 60_000);
    });
  });

  it('restores the ambient zone after a sync callback, a throw, and an async callback', async () => {
    const ambientTz = process.env.TZ;
    const ambientOffset = new Date(SUMMER).getTimezoneOffset();

    withHostTimeZone('Asia/Tokyo', () => undefined);
    expect(process.env.TZ).toBe(ambientTz);
    expect(new Date(SUMMER).getTimezoneOffset()).toBe(ambientOffset);

    expect(() => withHostTimeZone('Asia/Tokyo', () => { throw new Error('boom'); })).toThrow('boom');
    expect(process.env.TZ).toBe(ambientTz);
    expect(new Date(SUMMER).getTimezoneOffset()).toBe(ambientOffset);

    const inside = await withHostTimeZone('America/Denver', async () => {
      await Promise.resolve();
      return new Date(SUMMER).getTimezoneOffset();
    });
    expect(inside).toBe(360);
    expect(process.env.TZ).toBe(ambientTz);
    expect(new Date(SUMMER).getTimezoneOffset()).toBe(ambientOffset);
  });

  it('computes zone offsets from Intl, independently of the process zone', () => {
    expect(zoneOffsetMinutes('America/Denver', SUMMER)).toBe(360);
    expect(zoneOffsetMinutes('America/Denver', WINTER)).toBe(420);
    expect(zoneOffsetMinutes('Asia/Tokyo', SUMMER)).toBe(-540);
    expect(zoneOffsetMinutes('Asia/Kathmandu', SUMMER)).toBe(-345);
    expect(zoneOffsetMinutes('UTC', SUMMER)).toBe(0);
  });
});
