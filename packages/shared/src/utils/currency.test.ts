import { describe, it, expect } from 'vitest';
import {
  CURRENCY_CODES, isKnownCurrency, minorUnitExponent, isZeroDecimal,
  toMinorUnits, fromMinorUnits, roundToCurrency, multiplyToCurrency, isRepresentableInCurrency, formatCurrencyAmount, formatMoney,
  buildStripeCurrencyWarning,
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

  describe('exact half-up (review #2: binary FP must not break ties)', () => {
    it('0.02 h x 7.25 USD is 0.15, matching the SQL ROUND() path', () => {
      // The double product is 0.14499999999999999; Math.floor(n*100+0.5) gave 0.14.
      expect(multiplyToCurrency('0.02', '7.25', 'USD')).toBe('0.15');
      expect(roundToCurrency(0.02 * 7.25, 'USD')).toBe('0.15');
      expect(roundToCurrency('0.145', 'USD')).toBe('0.15');
    });
    it('1.005 USD rounds to 1.01 as a string and as a number', () => {
      expect(roundToCurrency('1.005', 'USD')).toBe('1.01');
      expect(roundToCurrency(1.005, 'USD')).toBe('1.01');
      expect(multiplyToCurrency('3', '0.335', 'USD')).toBe('1.01');
    });
    it('zero-decimal half-unit boundaries round up', () => {
      expect(roundToCurrency('0.5', 'JPY')).toBe('1.00');
      expect(roundToCurrency(0.5, 'JPY')).toBe('1.00');
      expect(roundToCurrency('2.5', 'JPY')).toBe('3.00');
      expect(roundToCurrency('2.49', 'JPY')).toBe('2.00');
      expect(multiplyToCurrency('0.5', '5', 'JPY')).toBe('3.00');
      expect(multiplyToCurrency('0.33', '1000', 'JPY')).toBe('330.00');
    });
    it('ties go toward +infinity (Math.floor(n+0.5) semantics kept for negatives)', () => {
      expect(roundToCurrency('-1.005', 'USD')).toBe('-1.00');
      expect(roundToCurrency('-1.006', 'USD')).toBe('-1.01');
      expect(roundToCurrency('-0.001', 'USD')).toBe('0.00');
      expect(roundToCurrency('-0.5', 'JPY')).toBe('0.00');
    });
    it('accepts exponent notation, blank, and plain integers', () => {
      expect(roundToCurrency(1e-7, 'USD')).toBe('0.00');
      expect(roundToCurrency('1e2', 'USD')).toBe('100.00');
      expect(roundToCurrency('', 'USD')).toBe('0.00');
      expect(roundToCurrency(42, 'USD')).toBe('42.00');
      expect(roundToCurrency('.5', 'USD')).toBe('0.50');
      expect(() => roundToCurrency('abc', 'USD')).toThrow(/non-finite/);
      expect(() => multiplyToCurrency(Number.NaN, '1', 'USD')).toThrow(/non-finite/);
    });
    it('exact multiplication never rounds through a float between steps', () => {
      expect(multiplyToCurrency('0.05', '0.70', 'USD')).toBe('0.04'); // 0.035 exactly
      expect(multiplyToCurrency('1.5', '150', 'USD')).toBe('225.00');
      expect(multiplyToCurrency('0', '99.99', 'USD')).toBe('0.00');
      expect(multiplyToCurrency(1.1, 1.1, 'USD')).toBe('1.21');
    });
  });

  it('isRepresentableInCurrency checks the exact decimal, not a float round-trip', () => {
    expect(isRepresentableInCurrency('1.01', 'USD')).toBe(true);
    expect(isRepresentableInCurrency('1.005', 'USD')).toBe(false);
    expect(isRepresentableInCurrency('1.0151', 'USD')).toBe(false); // old impl said true
    expect(isRepresentableInCurrency('12.00', 'JPY')).toBe(true);
    expect(isRepresentableInCurrency('1000.50', 'JPY')).toBe(false);
    expect(isRepresentableInCurrency(Number.NaN, 'USD')).toBe(false);
  });

  it('formatCurrencyAmount uses Intl and falls back on unknown codes', () => {
    expect(formatCurrencyAmount('1234.5', 'USD', 'en-US')).toBe('$1,234.50');
    expect(formatCurrencyAmount('1000.00', 'JPY', 'en-US')).toBe('¥1,000');
    // Unknown code: bare-code fallback, never a throw.
    expect(formatCurrencyAmount('12.00', 'ZZ1', 'en-US')).toBe('12.00 ZZ1');
  });
});

describe('formatMoney', () => {
  it('formats supported currencies with the requested locale', () => {
    expect(formatMoney('1234.5', 'USD', 'en-US')).toBe('$1,234.50');
    expect(formatMoney('1000.00', 'JPY', 'en-US')).toBe('¥1,000');
    expect(formatMoney(1234.5, 'EUR', 'de-DE')).toBe('1.234,50 €');
    expect(formatMoney(888888.88, 'CHF', 'de-CH')).toMatch(/^CHF/);
    expect(formatMoney(-5, 'USD', 'en-US')).toBe('-$5.00');
  });

  it('coerces null and non-numeric values to zero', () => {
    expect(formatMoney(null, 'USD', 'en-US')).toBe('$0.00');
    expect(formatMoney('abc', 'USD', 'en-US')).toBe('$0.00');
  });

  it('normalizes unknown codes and falls back without throwing', () => {
    expect(formatMoney('12.00', 'ZZ1', 'en-US')).toBe('12.00 ZZ1');
    expect(formatMoney(5, 'us', 'en-US')).toBe('5.00 US');
  });

  it('uses the runtime default when locale is undefined', () => {
    expect(() => formatMoney(1, 'USD', undefined)).not.toThrow();
    expect(formatMoney(1, 'USD', undefined)).toContain('1');
  });

  it('retains formatCurrencyAmount as an alias', () => {
    expect(formatCurrencyAmount).toBe(formatMoney);
  });
});

describe('buildStripeCurrencyWarning', () => {
  it('returns the warn-dont-block shape when the account settles in a different currency', () => {
    const w = buildStripeCurrencyWarning('EUR', 'USD');
    expect(w).toMatchObject({
      code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT',
      documentCurrency: 'EUR',
      accountCurrency: 'USD',
    });
    expect(w?.message).toContain('FX spread');
    expect(w?.message).toContain('EUR');
    expect(w?.message).toContain('USD');
  });

  it('is null when the currencies match case-insensitively', () => {
    expect(buildStripeCurrencyWarning('EUR', 'eur')).toBeNull();
    expect(buildStripeCurrencyWarning('usd', 'USD')).toBeNull();
  });

  it('an UNKNOWN account currency is an explicit "cache unavailable" warning, never silent no-warning (review F6)', () => {
    for (const unknown of [null, undefined, '', '  ']) {
      const w = buildStripeCurrencyWarning('EUR', unknown);
      expect(w).toMatchObject({
        code: 'STRIPE_ACCOUNT_CURRENCY_UNKNOWN',
        documentCurrency: 'EUR',
        accountCurrency: null,
      });
      expect(w?.message).toMatch(/refresh/i);
      expect(w?.message).toContain('EUR');
    }
  });

  it('is null only when the document currency itself is missing (nothing to compare)', () => {
    expect(buildStripeCurrencyWarning('', 'USD')).toBeNull();
    expect(buildStripeCurrencyWarning('', null)).toBeNull();
  });
});
