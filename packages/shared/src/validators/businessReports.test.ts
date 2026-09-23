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
});
