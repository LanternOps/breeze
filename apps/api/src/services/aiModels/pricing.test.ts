// apps/api/src/services/aiModels/pricing.test.ts
import { describe, expect, it } from 'vitest';
import { UnpricedOptionError, computeInvocationCents, platformRateSnapshot, priceInvocation, type RateSnapshot } from './pricing';

const STANDARD = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const FAST = { inputCentsPerM: 800, outputCentsPerM: 4000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 1000 };
const RATE: RateSnapshot = { source: 'platform', standard: STANDARD, option: { key: 'speed:fast', rates: FAST } };
const ONE_M = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };

describe('priceInvocation', () => {
  it('prices every token component at the standard rate', () => {
    expect(priceInvocation(RATE, ONE_M, {})).toBe(400 + 2000 + 20 + 500);
    expect(priceInvocation(RATE, ONE_M, { speed: 'standard' })).toBe(2920);
  });

  it('prices a fast-mode call from the option rate', () => {
    expect(priceInvocation(RATE, ONE_M, { speed: 'fast' })).toBe(800 + 4000 + 40 + 1000);
  });

  it('never prices fast at the standard rate: an unpriced variant throws', () => {
    expect(() => priceInvocation({ source: 'platform', standard: STANDARD }, ONE_M, { speed: 'fast' }))
      .toThrow(UnpricedOptionError);
  });

  it('rounds to 6 decimal places of a cent', () => {
    const tiny: RateSnapshot = {
      source: 'platform',
      standard: { inputCentsPerM: 0.4, outputCentsPerM: 1.6, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 },
    };
    expect(priceInvocation(tiny, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, {})).toBe(0); // 0.0000004
    expect(priceInvocation(tiny, { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, {})).toBe(0.000002); // 0.0000016
    expect(priceInvocation(RATE, { input: 3, output: 7, cacheRead: 11, cacheWrite: 13 }, {})).toBe(0.02192);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a %s token count', (bad) => {
    expect(() => priceInvocation(RATE, { ...ONE_M, output: bad }, {})).toThrow(RangeError);
  });

  it('computeInvocationCents is the unrounded value', () => {
    expect(computeInvocationCents(RATE, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, {})).toBeCloseTo(0.0004, 12);
  });
});

describe('platformRateSnapshot', () => {
  it('is null for an unpriced row', () => {
    expect(platformRateSnapshot({ rates: null, optionRates: null })).toBeNull();
  });
  it('carries the fast rate only when one is set', () => {
    expect(platformRateSnapshot({ rates: STANDARD, optionRates: null })).toEqual({ source: 'platform', standard: STANDARD });
    expect(platformRateSnapshot({ rates: STANDARD, optionRates: { 'speed:fast': FAST } })).toEqual(RATE);
  });
});
