import { describe, it, expect } from 'vitest';
import {
  CURRENCY_CODES, isKnownCurrency, minorUnitExponent, isZeroDecimal,
  toMinorUnits, fromMinorUnits, roundToCurrency, formatCurrencyAmount,
} from './currency';

describe('currency core', () => {
  it('curated list contains no 3-decimal currencies (spec §4)', () => {
    for (const bad of ['BHD', 'KWD', 'OMR', 'JOD', 'TND']) {
      expect(CURRENCY_CODES).not.toContain(bad);
    }
    expect(CURRENCY_CODES).toContain('USD');
    expect(CURRENCY_CODES.length).toBe(34);
  });

  it('isKnownCurrency trims + uppercases', () => {
    expect(isKnownCurrency(' eur ')).toBe(true);
    expect(isKnownCurrency('ZZZ')).toBe(false);
  });

  it('minor-unit exponents: 0 for zero-decimal, else 2', () => {
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('CLP')).toBe(0);
    expect(minorUnitExponent('EUR')).toBe(2);
    expect(isZeroDecimal('jpy')).toBe(true);
    expect(isZeroDecimal('USD')).toBe(false);
  });

  it('toMinorUnits matches the Stripe contract (JPY not x100)', () => {
    expect(toMinorUnits('10.50', 'USD')).toBe(1050);
    expect(toMinorUnits('1000', 'JPY')).toBe(1000);
    expect(() => toMinorUnits(Number.NaN, 'USD')).toThrow();
  });

  it('fromMinorUnits returns fixed-2 major-unit strings', () => {
    expect(fromMinorUnits(1050, 'USD')).toBe('10.50');
    expect(fromMinorUnits(1000, 'JPY')).toBe('1000.00');
  });

  it('roundToCurrency rounds half-up at the currency exponent, fixed-2 output', () => {
    expect(roundToCurrency('10.505', 'USD')).toBe('10.51');
    expect(roundToCurrency('1000.50', 'JPY')).toBe('1001.00');
    expect(roundToCurrency('1000.49', 'JPY')).toBe('1000.00');
    expect(roundToCurrency(0, 'JPY')).toBe('0.00');
  });

  it('formatCurrencyAmount uses Intl and falls back on unknown codes', () => {
    expect(formatCurrencyAmount('1234.5', 'USD', 'en-US')).toBe('$1,234.50');
    expect(formatCurrencyAmount('1000.00', 'JPY', 'en-US')).toBe('¥1,000');
    // Unknown code: bare-code fallback, never a throw.
    expect(formatCurrencyAmount('12.00', 'ZZ1', 'en-US')).toBe('12.00 ZZ1');
  });
});
