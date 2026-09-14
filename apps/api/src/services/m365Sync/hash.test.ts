import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalize } from './hash';

describe('canonicalHash (spec §5.4)', () => {
  it('is insensitive to object key ORDER at the top level', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('is insensitive to key order at EVERY nesting depth', () => {
    const left = { outer: { z: { q: 1, p: 2 }, a: 3 } };
    const right = { outer: { a: 3, z: { p: 2, q: 1 } } };
    expect(canonicalHash(left)).toBe(canonicalHash(right));
  });

  it('sorts arrays of primitives, so a Graph reordering of assignedLicenses is not a change', () => {
    expect(canonicalHash({ skus: ['b', 'a', 'c'] })).toBe(canonicalHash({ skus: ['c', 'b', 'a'] }));
  });

  it('sorts arrays of OBJECTS by their canonical string', () => {
    const a = { roles: [{ id: '2', name: 'b' }, { id: '1', name: 'a' }] };
    const b = { roles: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('sorts objects nested INSIDE array elements too', () => {
    const a = { roles: [{ name: 'a', id: '1' }] };
    const b = { roles: [{ id: '1', name: 'a' }] };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('DISTINGUISHES a real value change (this is not a constant function)', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash({ skus: ['a'] })).not.toBe(canonicalHash({ skus: ['a', 'a'] }));
    expect(canonicalHash({ enabled: true })).not.toBe(canonicalHash({ enabled: false }));
    expect(canonicalHash({ a: '1' })).not.toBe(canonicalHash({ a: 1 }));
  });

  it('treats undefined and a missing key as null, so a dropped optional field is stable', () => {
    expect(canonicalize({ a: undefined })).toEqual({ a: null });
    expect(canonicalHash({ a: undefined, b: 1 })).toBe(canonicalHash({ a: null, b: 1 }));
  });

  it('preserves explicit null and does not collapse it into an empty string', () => {
    expect(canonicalHash({ a: null })).not.toBe(canonicalHash({ a: '' }));
  });

  it('returns 64 lowercase hex characters', () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls (no Map/Set iteration leaking in)', () => {
    const record = { z: [3, 1, 2], a: { b: [{ y: 1 }, { x: 2 }] } };
    expect(canonicalHash(record)).toBe(canonicalHash(record));
  });
});
