import { describe, expect, it } from 'vitest';
import { fourDigitSuffix } from './fixtureNumbering';

describe('fourDigitSuffix', () => {
  it('never exceeds 4 characters, even for scientific-notation-shaped slices (#4495)', () => {
    // Regression inputs from #4495: Number('4e19') parses as scientific
    // notation (4e19 === 40000000000000000000), which is the exact shape
    // that overflowed tickets.internal_number varchar(20) in CI.
    const sciNotationLikeSuffixes = ['4e19', '1e99', '2e05', '9e-1', '1e+5', '0e00'];
    for (const suffix of sciNotationLikeSuffixes) {
      const result = fourDigitSuffix(suffix);
      expect(result).toHaveLength(4);
      expect(result).toMatch(/^\d{4}$/);
    }
  });

  it('never exceeds 4 characters with the +1 offset used to derive a second fixture number', () => {
    for (const suffix of ['4e19', '9999', 'zzzz', '0000', '1e99']) {
      const result = fourDigitSuffix(suffix, 1);
      expect(result).toHaveLength(4);
      expect(result).toMatch(/^\d{4}$/);
    }
  });

  it('is deterministic for the same input', () => {
    expect(fourDigitSuffix('ab12')).toBe(fourDigitSuffix('ab12'));
    expect(fourDigitSuffix('4e19', 1)).toBe(fourDigitSuffix('4e19', 1));
  });

  it('wraps at the top of the range instead of growing past 4 digits', () => {
    // 'zzzz' in base36 is the maximum 4-char value; +1 must wrap, not overflow.
    const base = fourDigitSuffix('zzzz');
    const next = fourDigitSuffix('zzzz', 1);
    expect(next).toHaveLength(4);
    expect(next).not.toBe(base);
  });
});
