import { describe, expect, it } from 'vitest';
import { compareSoftwareVersions, compareVersions, normalizeSoftwareVersion } from './softwareVersionCompare';

describe('normalizeSoftwareVersion', () => {
  it.each([
    ['1.2.0.0', ['1', '2']],
    ['0.0', ['0']],
    ['0', ['0']],
    ['1.10', ['1', '10']],
    ['1.0.05', ['1', '0', '5']],
    ['  V01.02.000-beta  ', ['1', '2']],
    ['1.2.RC1', ['1', '2']],
    ['1.2+meta', ['1', '2']],
    ['10.0.5 (x64)', ['10', '0', '5']],
    ['7.0 build 1234', ['7']],
  ] as const)('normalizes %s', (input, expected) => {
    expect(normalizeSoftwareVersion(input)).toEqual(expected);
  });

  it.each(['', '   ', 'unknown', null, undefined])('rejects %s', (input) => {
    expect(normalizeSoftwareVersion(input)).toBeNull();
    expect(compareSoftwareVersions(input, '1.0')).toBeNull();
    expect(compareSoftwareVersions('1.0', input)).toBeNull();
  });
});

describe('compareSoftwareVersions', () => {
  it.each([
    ['1.2.10', '1.2.9', 1],
    ['10.10', '10.2', 1],
    ['14.0.1.4', '14.0.1.10', -1],
    ['1.2', '1.2.0', 0],
    ['1.2.3-beta', '1.2.3', 0],
    ['v2.0', '1.9', 1],
    ['10.0.5 (x64)', '10.0.5', 0],
    ['7.0 build 1234', '7', 0],
    ['1.02', '1.2', 0],
    ['20231015123456', '20231015123455', 1],
    ['9007199254740993', '9007199254740992', 1],
    ['99999999999999999999999999999999999', '100000000000000000000000000000000000', -1],
    ['0.0', '0', 0],
    ['1.0.05', '1.0.5', 0],
  ] as const)('compares %s against %s', (a, b, expected) => {
    expect(compareSoftwareVersions(a, b)).toBe(expected);
    expect(compareSoftwareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it('agrees wherever strict comparison is non-null for safe numeric and decorated versions', () => {
    // The legacy monitor uses parseInt/Number; parity applies to its exact
    // numeric domain, not huge integers rounded by IEEE-754.
    const versions = ['0', '0.0', '1', '1.0', '01.02', '1.2.0', '1.2.3', '1.2.10', '10.10', '14.0.1.4', '14.0.1.10', '20231015123456', '', 'unknown', 'v2.0', '1.2-beta', '1.bad', '2.bad'];
    for (const a of versions) {
      for (const b of versions) {
        const strict = compareVersions(a, b);
        if (strict !== null) {
          expect(compareSoftwareVersions(a, b), `${a} vs ${b}`).toBe(strict);
        }
      }
    }
  });

  it('preserves the strict monitor behavior for suffixes and prefixes', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBeNull();
    expect(compareVersions('v2.0', '1.9')).toBeNull();
    expect(compareVersions(' 1.2 ', '1.2')).toBeNull();
    expect(compareVersions('1.bad', '2.bad')).toBe(-1);
  });

  it('keeps legacy rounding unchanged while the inventory comparator retains huge-integer precision', () => {
    expect(compareVersions('9007199254740992', '9007199254740993')).toBe(0);
    expect(compareSoftwareVersions('9007199254740992', '9007199254740993')).toBe(-1);
  });
});
