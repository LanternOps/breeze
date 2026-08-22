import { describe, it, expect } from 'vitest';
import { currencyCodeSchema } from './currency';

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
