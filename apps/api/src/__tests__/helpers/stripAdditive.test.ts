import { describe, it, expect } from 'vitest';
import { stripAdditive } from './stripAdditive';

describe('stripAdditive', () => {
  it('removes declared keys, including through arrays and nested paths', () => {
    const body = { a: { b: [{ c: 1, d: 2 }, { c: 3, d: 4 }] }, e: 5, f: 6 };
    expect(stripAdditive(body, ['a.b[].c', 'f'])).toEqual({ a: { b: [{ d: 2 }, { d: 4 }] }, e: 5 });
    expect(body.f).toBe(6); // the input is not mutated
  });

  it('throws when a declared top-level or nested key is missing', () => {
    expect(() => stripAdditive({ a: 1 }, ['b'])).toThrow(/"b"/);
    expect(() => stripAdditive({ a: { x: 1 } }, ['a.y'])).toThrow(/"a\.y"/);
  });

  it('throws on an empty array: a declared per-element key cannot be proven added', () => {
    expect(() => stripAdditive({ lines: [] }, ['lines[].id'])).toThrow(/lines\[\]\.id/);
  });

  it('throws when only some elements carry the declared key', () => {
    expect(() => stripAdditive({ lines: [{ id: 'a' }, { name: 'b' }] }, ['lines[].id'])).toThrow();
  });
});
