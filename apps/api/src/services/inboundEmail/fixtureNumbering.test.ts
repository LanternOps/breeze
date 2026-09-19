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

  it('wraps exactly at the 9999 -> 0000 boundary', () => {
    // '07pr' is the base36 encoding of 9999 (parseInt('07pr', 36) === 9999),
    // so this exercises the true top-of-range wraparound the previous test's
    // name implied but 'zzzz' (-> 9615) doesn't actually reach.
    expect(fourDigitSuffix('07pr')).toBe('9999');
    expect(fourDigitSuffix('07pr', 1)).toBe('0000');
  });

  it('never throws or produces non-4-digit output for the real caller\'s edge-case suffix shapes', () => {
    // The real fixture builds suffix as `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.
    // Math.random()'s base36 tail can be shorter than 4 chars (e.g. when the
    // random value is close to 0), which pulls the epoch/suffix separator '-'
    // into the 4-char slice (e.g. "0-i5"). Also cover a fully empty input and
    // an all-'-' slice as hard edge cases, none of which should throw or
    // produce output outside the 4-digit contract.
    const edgeCaseSuffixes = ['0-i5', '5--a', '----', '', 'a', 'ab', 'abc'];
    for (const suffix of edgeCaseSuffixes) {
      for (const offset of [0, 1]) {
        const result = fourDigitSuffix(suffix, offset);
        expect(result).toHaveLength(4);
        expect(result).toMatch(/^\d{4}$/);
      }
    }
  });
});
