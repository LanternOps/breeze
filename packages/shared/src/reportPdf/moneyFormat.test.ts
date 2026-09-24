import { describe, expect, it } from 'vitest';
import { formatMoney as canonicalFormatMoney } from '../utils/currency';
import { formatMinutes, formatMoney, formatPercent } from './moneyFormat';

// P4: this is a THIN WRAPPER around utils/currency's canonical formatMoney —
// null/undefined/''/NaN/non-finite -> 'N/A', otherwise delegate untouched.
// These tests pin the N/A guard and the delegation, not a re-derived Intl
// formatting core (there is exactly one formatting core, in utils/currency.ts).
describe('formatMoney', () => {
  it('delegates a numeric STRING to the canonical formatter, untouched', () => {
    expect(formatMoney('1234567.89', 'USD', 'en-US')).toBe(
      canonicalFormatMoney('1234567.89', 'USD', 'en-US'),
    );
    expect(formatMoney('1234567.89', 'USD', 'en-US')).toBe('$1,234,567.89');
  });

  it('formats zero-decimal currencies with no minor unit (delegated)', () => {
    expect(formatMoney('1234', 'JPY', 'en-US')).toBe(canonicalFormatMoney('1234', 'JPY', 'en-US'));
    expect(formatMoney('1234', 'JPY', 'en-US')).toBe('¥1,234');
  });

  it('is locale-aware (delegated)', () => {
    expect(formatMoney('1234.5', 'EUR', 'de-DE')).toBe(canonicalFormatMoney('1234.5', 'EUR', 'de-DE'));
  });

  it('an unknown or empty currency code degrades exactly as the canonical formatter does, never throws', () => {
    expect(formatMoney('10.00', '', 'en-US')).toBe(canonicalFormatMoney('10.00', '', 'en-US'));
    expect(formatMoney('10.00', 'XXQ', 'en-US')).toBe(canonicalFormatMoney('10.00', 'XXQ', 'en-US'));
  });

  it('null / undefined / empty string / non-numeric render as the N/A sentinel (never delegated to the canonical 0-coercion)', () => {
    expect(formatMoney(null, 'USD')).toBe('N/A');
    expect(formatMoney(undefined, 'USD')).toBe('N/A');
    expect(formatMoney('', 'USD')).toBe('N/A');
    expect(formatMoney('not a number', 'USD')).toBe('N/A');
    expect(formatMoney(Number.NaN, 'USD')).toBe('N/A');
    expect(formatMoney(Number.POSITIVE_INFINITY, 'USD')).toBe('N/A');
  });

  it('zero is a measured value, not N/A, and matches the canonical formatter', () => {
    expect(formatMoney('0', 'USD', 'en-US')).toBe(canonicalFormatMoney('0', 'USD', 'en-US'));
    expect(formatMoney(0, 'USD', 'en-US')).toBe(canonicalFormatMoney(0, 'USD', 'en-US'));
  });
});

describe('formatPercent', () => {
  it('renders a 0..1 ratio as a percentage with one digit by default', () => {
    expect(formatPercent(0.9376, undefined, 'en-US')).toBe('93.8%');
  });
  it('0 is a measured zero and 1 is a measured one', () => {
    expect(formatPercent(0, 0, 'en-US')).toBe('0%');
    expect(formatPercent(1, 0, 'en-US')).toBe('100%');
  });
  it('null is N/A, NOT 0% — an unmeasured attainment is not a failed one', () => {
    expect(formatPercent(null)).toBe('N/A');
  });
});

describe('formatMinutes', () => {
  it('renders hours and minutes', () => {
    expect(formatMinutes(0)).toBe('0h 00m');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(2475)).toBe('41h 15m');
  });
  it('null is N/A', () => {
    expect(formatMinutes(null)).toBe('N/A');
  });
});
