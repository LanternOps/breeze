import { describe, it, expect } from 'vitest';
import { currencyCodeSchema, changeCurrencySchema } from './currency';

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
  it('defaults clearLines to false and normalizes the code', () => {
    expect(changeCurrencySchema.parse({ currencyCode: 'usd' })).toEqual({ currencyCode: 'USD', clearLines: false });
    expect(changeCurrencySchema.parse({ currencyCode: 'JPY', clearLines: true })).toEqual({ currencyCode: 'JPY', clearLines: true });
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
});
