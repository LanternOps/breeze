import { describe, it, expect, vi } from 'vitest';
import { resolveReportDateRange, reportDateRangePresetDays } from './reportDateRange';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('resolveReportDateRange (#9562)', () => {
  it.each([
    ['last_7_days', 7],
    ['last_30_days', 30],
    ['last_90_days', 90],
  ] as const)('resolves the %s preset to a rolling window ending now', (preset, days) => {
    expect(resolveReportDateRange({ preset }, NOW)).toEqual({
      start: new Date(NOW.getTime() - days * DAY),
      end: NOW,
    });
  });

  it('keeps explicit start/end exactly as given (they win over a preset)', () => {
    expect(
      resolveReportDateRange({ preset: 'last_7_days', start: '2026-09-01', end: '2026-09-30T23:59:59Z' }, NOW),
    ).toEqual({ start: new Date('2026-09-01'), end: new Date('2026-09-30T23:59:59Z') });
  });

  it('a custom preset with one bound constrains only that bound', () => {
    expect(resolveReportDateRange({ preset: 'custom', start: '2026-09-01' }, NOW)).toEqual({
      start: new Date('2026-09-01'),
      end: null,
    });
  });

  it.each([
    ['no dateRange', undefined],
    ['an empty dateRange', {}],
    ['a custom preset without bounds', { preset: 'custom' }],
    ['an unknown preset', { preset: 'last_decade' }],
    ['a non-object', 'last_30_days'],
  ])('leaves the window open for %s', (_label, raw) => {
    expect(resolveReportDateRange(raw, NOW)).toEqual({ start: null, end: null });
  });

  it.each([
    ['start', { start: 'not-a-date' }],
    ['end', { preset: 'custom', start: '2026-09-01', end: '2026-13-45' }],
  ])('refuses an unparseable explicit %s instead of guessing a window', (bound, raw) => {
    expect(() => resolveReportDateRange(raw, NOW)).toThrow(`Invalid report date range: ${bound}`);
  });

  it('warns when an unknown preset leaves the window open, so an all-time report is never silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveReportDateRange({ preset: 'last_decade' }, NOW)).toEqual({ start: null, end: null });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('last_decade'));
      warn.mockClear();
      resolveReportDateRange({ preset: 'custom' }, NOW);
      resolveReportDateRange(undefined, NOW);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('exposes preset lengths for generators with their own date semantics', () => {
    expect(reportDateRangePresetDays({ preset: 'last_90_days' })).toBe(90);
    expect(reportDateRangePresetDays({ preset: 'custom' })).toBeNull();
    expect(reportDateRangePresetDays(undefined)).toBeNull();
  });
});
