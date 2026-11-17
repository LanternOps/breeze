import { describe, expect, it } from 'vitest';
import {
  REPORT_META_SEPARATOR,
  formatReportDate,
  formatReportDateTime,
  formatReportPeriod,
  partnerReportConventions,
  reportPageGeometry,
  resolveReportLocale,
} from './reportLocale';

const NY = { timeZone: 'America/New_York', dateFormat: 'MM/DD/YYYY', timeFormat: '12h' } as const;

describe('report locale (#12048)', () => {
  it('resolves page size and formats from the partner settings, A4 / US order / 12h when unset', () => {
    expect(resolveReportLocale({ pageSize: 'letter', dateFormat: 'DD/MM/YYYY', timeFormat: '24h' }, 'Europe/Berlin')).toEqual({
      pageSize: 'letter', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timeZone: 'Europe/Berlin',
    });
    expect(resolveReportLocale(undefined, 'UTC')).toEqual({ pageSize: 'a4', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', timeZone: 'UTC' });
    // Junk in the stored settings falls back rather than reaching the renderer.
    expect(resolveReportLocale({ pageSize: 'legal' as never, dateFormat: 'D.M.Y' as never, timeFormat: 'x' as never }, 'UTC'))
      .toMatchObject({ pageSize: 'a4', dateFormat: 'MM/DD/YYYY', timeFormat: '12h' });
  });

  it('maps a partner row to report conventions, dropping unknown values', () => {
    expect(partnerReportConventions({ documentPageSize: 'letter', settings: { dateFormat: 'DD/MM/YYYY', timeFormat: '24h' } }))
      .toEqual({ pageSize: 'letter', dateFormat: 'DD/MM/YYYY', timeFormat: '24h' });
    expect(partnerReportConventions({ documentPageSize: 'legal', settings: { dateFormat: 'D.M.Y', timeFormat: 'x' } }))
      .toEqual({ pageSize: null, dateFormat: null, timeFormat: null });
    expect(partnerReportConventions({ settings: null })).toEqual({ pageSize: null, dateFormat: null, timeFormat: null });
  });

  it('falls back to UTC for a timezone Intl cannot resolve, instead of throwing mid-render', () => {
    expect(resolveReportLocale(undefined, 'Pacific Standard Time').timeZone).toBe('UTC');
  });

  it('gives Letter and A4 landscape geometry with the same margins and band', () => {
    const letter = reportPageGeometry('letter');
    const a4 = reportPageGeometry('a4');
    expect(letter.w).toBeCloseTo(279.4, 1);
    expect(letter.h).toBeCloseTo(215.9, 1);
    expect(a4).toMatchObject({ w: 297, h: 210, footY: 199 });
    expect(letter.mx).toBe(a4.mx);
    expect(letter.bandH).toBe(a4.bandH);
    // The footer keeps the same distance from the bottom edge on both sizes.
    expect(letter.h - letter.footY).toBeCloseTo(a4.h - a4.footY, 5);
  });

  it('formats a calendar date in the partner order with a spelled month, never shifting a date-only value', () => {
    expect(formatReportDate('2026-11-09', NY)).toBe('Nov 9, 2026');
    expect(formatReportDate('2026-11-09', { ...NY, dateFormat: 'DD/MM/YYYY' })).toBe('9 Nov 2026');
    expect(formatReportDate('2026-11-09', { ...NY, dateFormat: 'YYYY-MM-DD' })).toBe('2026-11-09');
    // A bare date is a calendar day: New York must not turn it into Nov 8.
    expect(formatReportDate('2026-11-09', { ...NY, timeZone: 'Pacific/Honolulu' })).toBe('Nov 9, 2026');
  });

  it('formats an instant in the report timezone', () => {
    // 02:00 UTC on Nov 10 is still Nov 9 in New York.
    expect(formatReportDate('2026-11-10T02:00:00.000Z', NY)).toBe('Nov 9, 2026');
    expect(formatReportDate(new Date('2026-11-10T02:00:00.000Z'), { ...NY, timeZone: 'UTC' })).toBe('Nov 10, 2026');
  });

  it('returns null for a missing or unparseable value so the caller prints its own placeholder', () => {
    expect(formatReportDate(null, NY)).toBeNull();
    expect(formatReportDate('', NY)).toBeNull();
    expect(formatReportDate('not a date', NY)).toBeNull();
  });

  it('prints a generated timestamp with its timezone', () => {
    const at = new Date('2026-11-09T17:06:00.000Z');
    expect(formatReportDateTime(at, NY)).toBe('Nov 9, 2026, 12:06 PM EST');
    expect(formatReportDateTime(at, { timeZone: 'UTC', dateFormat: 'DD/MM/YYYY', timeFormat: '24h' })).toBe('9 Nov 2026, 17:06 UTC');
    expect(formatReportDateTime(at, { timeZone: 'Europe/Berlin', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })).toBe('2026-11-09, 18:06 GMT+1');
    // Midnight and noon on a 12-hour clock.
    expect(formatReportDateTime(new Date('2026-11-09T05:00:00.000Z'), NY)).toBe('Nov 9, 2026, 12:00 AM EST');
  });

  it('prints a period as one range in one format', () => {
    expect(formatReportPeriod('2026-10-10', '2026-11-09', NY)).toBe('Oct 10, 2026 – Nov 9, 2026');
    expect(formatReportPeriod('2026-10-10', null, NY)).toBeNull();
    expect(formatReportPeriod(undefined, '2026-11-09', NY)).toBeNull();
  });

  it('has one meta separator', () => {
    expect(REPORT_META_SEPARATOR.trim()).toBe('·');
  });
});
