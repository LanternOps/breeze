import { describe, expect, it } from 'vitest';
import { capWithSuffix, sliceUtf16 } from './accountingLineDescription';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('sliceUtf16 (#8605)', () => {
  it('returns short text unchanged', () => {
    expect(sliceUtf16('abc', 5)).toBe('abc');
  });
  it('cuts at the unit count', () => {
    expect(sliceUtf16('abcdef', 4)).toBe('abcd');
  });
  it('backs off one unit instead of ending on a high surrogate', () => {
    // 'a😀' is 3 units: a, high, low. A cut at 2 would leave a lone high surrogate.
    expect(sliceUtf16('a😀b', 2)).toBe('a');
    expect(sliceUtf16('a😀b', 3)).toBe('a😀');
  });
  it('returns empty for a non-positive budget', () => {
    expect(sliceUtf16('abc', 0)).toBe('');
    expect(sliceUtf16('abc', -3)).toBe('');
  });
});

describe('capWithSuffix (#8605)', () => {
  it('text within the cap is returned as is', () => {
    expect(capWithSuffix('note — tail', ' — tail', 11)).toBe('note — tail');
  });
  it('truncates before the suffix and keeps it whole', () => {
    expect(capWithSuffix(`${'x'.repeat(20)} — tail`, ' — tail', 10)).toBe('xxx — tail');
  });
  it('with no suffix, cuts the whole text', () => {
    expect(capWithSuffix('x'.repeat(20), '', 10)).toBe('x'.repeat(10));
  });
  it('ignores a suffix that is not the end of the text', () => {
    expect(capWithSuffix('x'.repeat(20), ' — tail', 10)).toBe('x'.repeat(10));
  });
  it('a suffix as long as the cap falls back to a plain cut', () => {
    expect(capWithSuffix('ab — tail', ' — tail', 7)).toBe('ab — ta');
  });
  it('emoji base: no lone surrogate, suffix whole', () => {
    const out = capWithSuffix(`${'😀'.repeat(20)} — tail`, ' — tail', 14);
    expect(out.length).toBeLessThanOrEqual(14);
    expect(LONE_SURROGATE.test(out)).toBe(false);
    expect(out).toBe('😀😀😀 — tail');
  });
});
