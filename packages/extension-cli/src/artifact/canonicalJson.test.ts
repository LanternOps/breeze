import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonicalJson';

describe('canonicalJson', () => {
  it('sorts object keys bytewise via Object.keys().sort()', () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts keys bytewise, not locale-aware (uppercase before lowercase)', () => {
    // "B" (0x42) sorts before "a" (0x61) in default Array.sort, unlike a
    // locale-aware collation which would put "a" first.
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it('sorts nested objects at every level', () => {
    const value = { z: { d: 1, c: 2 }, a: { y: 1, x: 2 } };
    expect(canonicalJson(value)).toBe('{"a":{"x":2,"y":1},"z":{"c":2,"d":1}}');
  });

  it('preserves array order without sorting elements', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('recurses into objects nested inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('emits no whitespace anywhere', () => {
    const value = { a: [1, 2, { b: 'x' }], c: { d: null } };
    expect(canonicalJson(value)).not.toMatch(/\s/);
  });

  it('serializes string keys and string values via JSON.stringify so escaping matches', () => {
    const value = { 'a"b': 'c\nd', 'e\\f': 'g\tunicode: é' };
    expect(canonicalJson(value)).toBe(
      `{${JSON.stringify('a"b')}:${JSON.stringify('c\nd')},${JSON.stringify('e\\f')}:${JSON.stringify('g\tunicode: é')}}`,
    );
  });

  it('serializes null, numbers, and booleans exactly as JSON.stringify does', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(3.14)).toBe('3.14');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it('serializes an empty object and empty array', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});
