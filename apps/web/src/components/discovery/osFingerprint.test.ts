import { describe, expect, it } from 'vitest';
import { normalizeOsFingerprint } from './osFingerprint';

describe('normalizeOsFingerprint (#9645)', () => {
  it.each([
    ['Windows', 'Windows'],
    [{ os: 'Cisco IOS' }, 'Cisco IOS'],
    ['', null],
    [{ os: '' }, null],
    [{ os: 5 }, null],
    [{}, null],
    [null, null],
    [undefined, null],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeOsFingerprint(input)).toBe(expected);
  });
});
