import { describe, it, expect } from 'vitest';
import { stripNul } from './stripNul';

describe('stripNul', () => {
  it('removes U+0000 from a string', () => {
    expect(stripNul('S\u0000e\u0000r\u0000')).toBe('Ser');
  });

  it('returns a NUL-free string unchanged', () => {
    expect(stripNul('clean')).toBe('clean');
  });

  it('strips nested object values, array items, and object keys', () => {
    const input = {
      'top\u0000Key': 1,
      nested: { list: ['a\u0000b', { 'k\u0000ey': 'v\u0000' }], keep: true, none: null },
    };
    expect(stripNul(input)).toEqual({
      topKey: 1,
      nested: { list: ['ab', { key: 'v' }], keep: true, none: null },
    });
  });

  it('leaves non-string primitives untouched', () => {
    expect(stripNul(5)).toBe(5);
    expect(stripNul(false)).toBe(false);
    expect(stripNul(null)).toBe(null);
    expect(stripNul(undefined)).toBe(undefined);
  });

  it('keeps a literal "__proto__" key as an own property', () => {
    const input = JSON.parse('{"__proto__": "x\\u0000"}');
    const out = stripNul(input) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toBe('x');
  });
});
