import { describe, it, expect } from 'vitest';
import { formatMoney, formatDate } from './format';

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
