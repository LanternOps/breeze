import { describe, it, expect } from 'vitest';
import { formatMoney, formatDate, sumByCurrency } from './format';

describe('formatMoney', () => {
  // NOTE: formatMoney takes a *dollar* amount (numeric(12,2)), not cents — every
  // call site passes API money strings like '500.00'. So 1125 → $1,125.00, and
  // 112500 → $112,500.00 (the task brief's "112500 → $1,125.00" example conflated
  // dollars with cents; dividing by 100 would break every billing surface).
  it('formats a whole USD amount with grouping and 2 decimals', () => {
    expect(formatMoney(1125)).toBe('$1,125.00');
  });

  it('treats the argument as dollars, not cents', () => {
    expect(formatMoney(112500)).toBe('$112,500.00');
  });

  it('formats a dollar string (the API shape) unchanged', () => {
    expect(formatMoney('123.40')).toBe('$123.40');
  });

  it('renders a non-USD currency with its symbol or code', () => {
    expect(formatMoney(0, 'EUR')).toMatch(/€|EUR/);
  });

  it('falls back to a plain amount + code for a malformed currency code', () => {
    // Intl.NumberFormat throws RangeError on a non-3-letter code → catch branch.
    expect(formatMoney(5, 'US')).toBe('5.00 US');
  });

  it('coerces a non-finite value to 0', () => {
    expect(formatMoney(null)).toBe('$0.00');
  });
});

describe('sumByCurrency', () => {
  it('returns [] for no entries', () => {
    expect(sumByCurrency([])).toEqual([]);
  });

  it('collapses a single currency to one entry (the pre-existing single-currency path)', () => {
    expect(
      sumByCurrency([
        { amount: 10, currencyCode: 'USD' },
        { amount: 5, currencyCode: 'USD' },
      ]),
    ).toEqual([{ code: 'USD', amount: 15 }]);
  });

  it('splits a mixed-currency set into one entry per currency, summed within each', () => {
    expect(
      sumByCurrency([
        { amount: 100, currencyCode: 'USD' },
        { amount: 50, currencyCode: 'EUR' },
        { amount: 25, currencyCode: 'USD' },
      ]),
    ).toEqual([
      { code: 'USD', amount: 125 },
      { code: 'EUR', amount: 50 },
    ]);
  });

  it('preserves first-seen order (stable), not alphabetical', () => {
    expect(
      sumByCurrency([
        { amount: 1, currencyCode: 'EUR' },
        { amount: 2, currencyCode: 'USD' },
      ]).map((e) => e.code),
    ).toEqual(['EUR', 'USD']);
  });

  it('coalesces a falsy currency code to USD (matching the strips’ || "USD" default)', () => {
    expect(sumByCurrency([{ amount: 3, currencyCode: '' }])).toEqual([{ code: 'USD', amount: 3 }]);
  });
});

describe('formatDate', () => {
  it('returns the em-dash fallback for null/undefined/empty', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  it('renders a YYYY-MM-DD date as a short locale date', () => {
    expect(formatDate('2026-06-16')).toBe(new Date('2026-06-16T00:00:00').toLocaleDateString());
  });

  it('returns the raw input when it is not a parseable date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});
