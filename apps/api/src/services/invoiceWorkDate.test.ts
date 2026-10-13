import { describe, it, expect, vi } from 'vitest';

const { captureMessageMock } = vi.hoisted(() => ({ captureMessageMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureMessage: captureMessageMock }));

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

  it('reports an invalid zone to Sentry once per zone, not once per line', () => {
    captureMessageMock.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'Mars/Olympus_Mons');
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock).toHaveBeenCalledWith(expect.any(String), { eventCode: 'invoice_work_date_invalid_timezone' });
    toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'America/New_York');
    expect(captureMessageMock).toHaveBeenCalledTimes(1); // a valid zone never reports
    warn.mockRestore();
  });

  it('formats as zero-padded YYYY-MM-DD', () => {
    expect(toPartnerLocalDate(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
  });
});
