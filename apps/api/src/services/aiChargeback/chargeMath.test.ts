import { describe, expect, it } from 'vitest';
import { divHalfUp, formatScaled, markupAmount, priceListAmount, toScaled } from './chargeMath';

const rates = { inputPricePerM: '3.60', outputPricePerM: '18', cacheReadPricePerM: '0.36', cacheWritePricePerM: '4.5' };
const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

describe('chargeMath (#7608 rounding rules RR1/RR2)', () => {
  it('parses and formats exact decimals', () => {
    expect(toScaled('3.6', 6)).toBe(3_600_000n);
    expect(toScaled('0.000001', 6)).toBe(1n);
    expect(toScaled('12', 2)).toBe(1200n);
    expect(formatScaled(0n, 6)).toBe('0.000000');
    expect(formatScaled(1_543n, 6)).toBe('0.001543');
    expect(formatScaled(3_639_600n, 6)).toBe('3.639600');
  });
  it('refuses negatives, exponents and excess precision', () => {
    expect(() => toScaled('-1', 6)).toThrow();
    expect(() => toScaled('1e3', 6)).toThrow();
    expect(() => toScaled('0.0000001', 6)).toThrow();
    expect(toScaled('0.1000000', 6)).toBe(100_000n); // trailing zeros beyond scale are exact
  });
  it('divHalfUp rounds half up', () => {
    expect(divHalfUp(5n, 10n)).toBe(1n);
    expect(divHalfUp(4n, 10n)).toBe(0n);
    expect(divHalfUp(15n, 10n)).toBe(2n);
  });
  it('price list: exact sum, one half-up round at 6 dp (RR1)', () => {
    // 1,000,000 × 3.60 + 2,000 × 18 + 10,000 × 0.36 + 0 = 3.6 + 0.036 + 0.0036 = 3.6396
    expect(priceListAmount(tokens(1_000_000, 2_000, 10_000), rates)).toBe('3.639600');
    // 500,000 tokens × 0.000001 / 1e6 = 0.0000005 → rounds UP to 0.000001
    expect(priceListAmount(tokens(500_000), { ...rates, inputPricePerM: '0.000001' })).toBe('0.000001');
    // 499,999 × 0.000001 / 1e6 = 0.000000499999 → 0.000000
    expect(priceListAmount(tokens(499_999), { ...rates, inputPricePerM: '0.000001' })).toBe('0.000000');
    expect(priceListAmount(tokens(0), rates)).toBe('0.000000');
  });
  it('markup: 25% of 0.123457 cents (RR2)', () => {
    // 0.123457 c × 1.25 = 0.15432125 c = 0.0015432125 USD → 0.001543
    expect(markupAmount(0.123457, '25')).toBe('0.001543');
    // 0% markup = cost passthrough: 250 c = 2.500000
    expect(markupAmount(250, '0')).toBe('2.500000');
    // 1000% of 10 c = 1.10 USD
    expect(markupAmount(10, '1000')).toBe('1.100000');
    // a float cost that is exact at 6 dp survives (numeric(20,6) read in number mode)
    expect(markupAmount(0.1 + 0.2, '0')).toBe('0.003000');
  });
  it('markup refuses a negative or non-finite cost', () => {
    expect(() => markupAmount(-1, '10')).toThrow();
    expect(() => markupAmount(Number.NaN, '10')).toThrow();
  });
});
