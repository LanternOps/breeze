import { describe, it, expect } from 'vitest';
import { currencyCodeSchema, changeCurrencySchema, manualExchangeRateBodySchema } from './currency';

describe('currencyCodeSchema', () => {
  it('accepts and normalizes case/whitespace', () => {
    expect(currencyCodeSchema.parse('usd')).toBe('USD');
    expect(currencyCodeSchema.parse(' eur ')).toBe('EUR');
  });
  it('rejects off-list and malformed codes', () => {
    for (const bad of ['ZZZ', 'US', 'USDD', '', '   ', 'xx1']) {
      expect(currencyCodeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('changeCurrencySchema', () => {
  it('defaults clearLines and reprice to false and normalizes the code', () => {
    expect(changeCurrencySchema.parse({ currencyCode: 'usd' })).toEqual({
      currencyCode: 'USD',
      clearLines: false,
      reprice: false,
    });
    expect(changeCurrencySchema.parse({ currencyCode: 'JPY', clearLines: true })).toEqual({
      currencyCode: 'JPY',
      clearLines: true,
      reprice: false,
    });
  });
  it('rejects off-list codes', () => {
    expect(changeCurrencySchema.safeParse({ currencyCode: 'ZZZ' }).success).toBe(false);
  });
  it('rejects unknown keys (strict)', () => {
    expect(changeCurrencySchema.safeParse({ currencyCode: 'EUR', convert: true }).success).toBe(false);
  });
  it('requires currencyCode', () => {
    expect(changeCurrencySchema.safeParse({}).success).toBe(false);
  });

  it('rejects clearLines and reprice together', () => {
    const r = changeCurrencySchema.safeParse({
      currencyCode: 'EUR',
      clearLines: true,
      reprice: true,
    });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toContainEqual(expect.objectContaining({
        message: 'clearLines and reprice are mutually exclusive',
        path: ['reprice'],
      }));
    }
  });
});

describe('manualExchangeRateBodySchema (reporting-only FX rate bounds)', () => {
  it('accepts a rate at the numeric(18,8) integer-digit ceiling', () => {
    // 10 integer digits + 8 decimals is exactly numeric(18,8).
    expect(manualExchangeRateBodySchema.parse({ rate: '1234567890.12345678' }).rate).toBe('1234567890.12345678');
  });

  it.each([
    ['11 integer digits', '12345678901.5'],
    ['11 integer digits, no fraction', '12345678901'],
    ['a very long integer part', '1'.repeat(40)],
  ])('rejects %s — numeric(18,8) cannot hold it, and a DB overflow would be a 500', (_label, rate) => {
    expect(manualExchangeRateBodySchema.safeParse({ rate }).success).toBe(false);
  });

  it('ignores leading zeros when measuring the integer part', () => {
    expect(manualExchangeRateBodySchema.safeParse({ rate: '0000000001.5' }).success).toBe(true);
  });
});
