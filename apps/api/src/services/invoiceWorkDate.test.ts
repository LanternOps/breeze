import { describe, it, expect } from 'vitest';
import { toPartnerLocalDate } from './invoiceWorkDate';

describe('toPartnerLocalDate (#8603)', () => {
  it('uses the partner zone, not UTC', () => {
    // 2026-09-17T02:30Z is the evening of Sep 16 in New York.
    expect(toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'America/New_York')).toBe('2026-09-16');
    expect(toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'UTC')).toBe('2026-09-17');
  });

  it('moves forward across the date line for an eastern zone', () => {
    // 2026-09-16T20:00Z is already Sep 17 in Auckland (UTC+12).
    expect(toPartnerLocalDate(new Date('2026-09-16T20:00:00Z'), 'Pacific/Auckland')).toBe('2026-09-17');
  });

  it('falls back to UTC for an unknown or empty zone (never throws)', () => {
    expect(toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'Not/AZone')).toBe('2026-09-17');
    expect(toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), '')).toBe('2026-09-17');
  });

  it('formats as zero-padded YYYY-MM-DD', () => {
    expect(toPartnerLocalDate(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
  });
});
