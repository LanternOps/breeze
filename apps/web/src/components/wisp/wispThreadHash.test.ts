import { describe, expect, it } from 'vitest';
import { concernIdFromHash, hashForConcern } from './wispThreadHash';

describe('wispThreadHash', () => {
  it('round-trips the concern hash', () => {
    expect(concernIdFromHash('#concern=c1')).toBe('c1');
    expect(concernIdFromHash('')).toBeNull();
    expect(hashForConcern('c1')).toBe('#concern=c1');
    expect(hashForConcern(null)).toBe('');
    expect(concernIdFromHash(hashForConcern('a b/c'))).toBe('a b/c');
  });

  it('ignores other hashes, an empty id and malformed percent-encoding', () => {
    expect(concernIdFromHash('#intent-1')).toBeNull();
    expect(concernIdFromHash('#concern=')).toBeNull();
    expect(concernIdFromHash('#concern=%E0%A4%A')).toBeNull();
  });
});
