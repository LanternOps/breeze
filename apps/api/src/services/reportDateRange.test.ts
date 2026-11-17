import { describe, it, expect, vi } from 'vitest';
import { resolveAdHocEvidenceWindow, resolveReportDateRange, reportDateRangePresetDays } from './reportDateRange';

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

describe('resolveAdHocEvidenceWindow (#12048)', () => {
  const GENERATED = '2026-11-09T17:06:00.000Z';

  it('defaults to the trailing 30 days ending at generation, so every service-plan report prints one period', () => {
    expect(resolveAdHocEvidenceWindow(undefined, GENERATED)).toEqual({
      start: new Date(new Date(GENERATED).getTime() - 30 * DAY),
      end: new Date(GENERATED),
      periodStart: '2026-10-10',
      periodEnd: '2026-11-09',
    });
  });

  it('honours a rolling preset', () => {
    expect(resolveAdHocEvidenceWindow({ preset: 'last_7_days' }, GENERATED)).toMatchObject({
      periodStart: '2026-11-02',
      periodEnd: '2026-11-09',
    });
  });

  it('names the bad bound instead of throwing a bare RangeError', () => {
    expect(() => resolveAdHocEvidenceWindow({ start: 'last tuesday' }, GENERATED))
      .toThrow('Invalid report date range: start "last tuesday" is not a date');
    expect(() => resolveAdHocEvidenceWindow({ end: '2026-13-45' }, GENERATED))
      .toThrow('Invalid report date range: end "2026-13-45" is not a date');
  });

  it('gives threat detection and vulnerability management one window for one config', () => {
    // Both generators call this; equal input → equal window is the #12048 contract.
    expect(resolveAdHocEvidenceWindow({ preset: 'last_30_days' }, GENERATED))
      .toEqual(resolveAdHocEvidenceWindow(undefined, GENERATED));
    expect(resolveAdHocEvidenceWindow({ end: '2026-11-09' }, GENERATED)).toMatchObject({ periodStart: '2026-10-10', periodEnd: '2026-11-09' });
  });

  it('reads explicit bounds as whole days', () => {
    expect(resolveAdHocEvidenceWindow({ start: '2026-10-01', end: '2026-10-31' }, GENERATED)).toEqual({
      start: new Date('2026-10-01T00:00:00.000Z'),
      end: new Date('2026-10-31T23:59:59.999Z'),
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    });
  });
});
