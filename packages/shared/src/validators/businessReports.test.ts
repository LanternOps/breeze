import { describe, expect, it } from 'vitest';
import { periodSchema } from './businessReports';

describe('periodSchema', () => {
  it('accepts each period kind with no start/end', () => {
    for (const kind of ['last_full_month', 'last_30_days', 'last_quarter'] as const) {
      expect(periodSchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it('accepts a custom period with ISO date start/end', () => {
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-01-01', end: '2026-01-31' }).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(periodSchema.safeParse({ kind: 'last_year' }).success).toBe(false);
  });

  it('rejects a non-ISO start/end date', () => {
    expect(periodSchema.safeParse({ kind: 'custom', start: '01/01/2026' }).success).toBe(false);
  });

  // #3198 W02 fix round (item 4): a custom period is complete and real, or it
  // is refused at write time — never silently resolved to a different window.
  it('rejects a custom period missing start or end', () => {
    expect(periodSchema.safeParse({ kind: 'custom' }).success).toBe(false);
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-01-01' }).success).toBe(false);
    expect(periodSchema.safeParse({ kind: 'custom', end: '2026-01-31' }).success).toBe(false);
  });

  it('rejects impossible calendar dates', () => {
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-02-31', end: '2026-03-10' }).success).toBe(false);
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-02-01', end: '2026-13-01' }).success).toBe(false);
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-02-00', end: '2026-02-10' }).success).toBe(false);
  });

  it('rejects an inverted custom range but accepts a single-day one (end is inclusive)', () => {
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-03-15', end: '2026-03-01' }).success).toBe(false);
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-03-15', end: '2026-03-15' }).success).toBe(true);
  });

  it('accepts a leap day only in a leap year', () => {
    expect(periodSchema.safeParse({ kind: 'custom', start: '2028-02-29', end: '2028-03-01' }).success).toBe(true);
    expect(periodSchema.safeParse({ kind: 'custom', start: '2026-02-29', end: '2026-03-01' }).success).toBe(false);
  });
});
