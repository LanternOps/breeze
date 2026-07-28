import { describe, it, expect, vi } from 'vitest';

// Avoid real Redis/DB/Sentry side effects when importing the module under test.
vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: (fn: any) => fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: () => {} }));

import { extractRowCount, clampRetentionDays, resolveRetentionDays } from './deviceMetricsRetention';

describe('extractRowCount (batched-delete loop termination depends on this)', () => {
  it('prefers rowCount (node-postgres) over count', () => {
    expect(extractRowCount({ rowCount: 7, count: 3 })).toBe(7);
  });

  it('falls back to count (postgres-js DELETE result)', () => {
    expect(extractRowCount({ count: 5 })).toBe(5);
  });

  it('falls back to array length when the driver returns rows', () => {
    expect(extractRowCount([{}, {}, {}])).toBe(3);
  });

  it('returns 0 for an unrecognized object shape (does not falsely terminate as a partial batch)', () => {
    expect(extractRowCount({})).toBe(0);
  });

  it('reports a full batch as the batch size so the loop continues', () => {
    expect(extractRowCount({ count: 10000 })).toBe(10000);
  });
});

describe('clampRetentionDays', () => {
  it('keeps an in-range value untouched', () => {
    expect(clampRetentionDays(30)).toBe(30);
  });

  it('raises anything below one day to one day', () => {
    expect(clampRetentionDays(0)).toBe(1);
    expect(clampRetentionDays(-5)).toBe(1);
  });

  it('caps at one year so a typo cannot disable retention outright', () => {
    expect(clampRetentionDays(100000)).toBe(365);
  });
});

describe('resolveRetentionDays', () => {
  it('uses the configured value when it parses', () => {
    expect(resolveRetentionDays('45', 30)).toBe(45);
  });

  it('falls back when the value is unset', () => {
    expect(resolveRetentionDays(undefined, 30)).toBe(30);
    expect(resolveRetentionDays('', 30)).toBe(30);
  });

  // A clamp alone cannot save this: Math.max(1, NaN) is NaN, which reaches
  // `new Date(NaN).toISOString()` and throws RangeError on every run.
  it('falls back on unparseable input rather than producing NaN', () => {
    const result = resolveRetentionDays('nonsense', 30);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(30);
  });

  // `=0` reads as "no retention"; clamping to 1 would delete almost everything.
  it('falls back on zero rather than clamping it to a one-day window', () => {
    expect(resolveRetentionDays('0', 30)).toBe(30);
  });

  it('still clamps an out-of-range configured value', () => {
    expect(resolveRetentionDays('100000', 30)).toBe(365);
    expect(resolveRetentionDays('-5', 30)).toBe(30);
  });
});
