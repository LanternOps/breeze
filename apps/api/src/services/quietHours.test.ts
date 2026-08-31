import { describe, it, expect } from 'vitest';
import { isInQuietHours } from './quietHours';

const at = (iso: string) => new Date(iso);

describe('isInQuietHours', () => {
  it('is false when unset or disabled', () => {
    expect(isInQuietHours(null)).toBe(false);
    expect(isInQuietHours({ start: '22:00', end: '07:00', enabled: false, timezone: 'UTC' })).toBe(false);
  });
  it('handles an overnight window in UTC', () => {
    const cfg = { start: '22:00', end: '07:00', timezone: 'UTC' };
    expect(isInQuietHours(cfg, at('2026-01-01T23:30:00Z'))).toBe(true);
    expect(isInQuietHours(cfg, at('2026-01-01T06:59:00Z'))).toBe(true);
    expect(isInQuietHours(cfg, at('2026-01-01T12:00:00Z'))).toBe(false);
  });
  it('handles a same-day window and treats start==end as always quiet', () => {
    expect(isInQuietHours({ start: '09:00', end: '17:00', timezone: 'UTC' }, at('2026-01-01T10:00:00Z'))).toBe(true);
    expect(isInQuietHours({ start: '09:00', end: '09:00', timezone: 'UTC' }, at('2026-01-01T03:00:00Z'))).toBe(true);
  });
  it('is false on a malformed time', () => {
    expect(isInQuietHours({ start: '25:00', end: '07:00', timezone: 'UTC' }, at('2026-01-01T03:00:00Z'))).toBe(false);
  });
});
