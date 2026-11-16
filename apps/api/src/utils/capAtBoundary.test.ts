import { describe, expect, it } from 'vitest';
import { capAtBoundary } from './capAtBoundary';

describe('capAtBoundary', () => {
  it('returns short text unchanged', () => {
    expect(capAtBoundary('hello', 10)).toBe('hello');
  });

  it('cuts at a word boundary with a visible marker, within the cap', () => {
    const out = capAtBoundary('alpha beta gamma delta epsilon', 20);
    expect(Array.from(out).length).toBeLessThanOrEqual(20);
    expect(out).toBe('alpha beta gamma…');
  });

  it('prefers a paragraph break in the back half', () => {
    const text = `${'a'.repeat(12)}\n\n${'b '.repeat(20)}`;
    expect(capAtBoundary(text, 20)).toBe(`${'a'.repeat(12)}…`);
  });

  it('never splits a surrogate pair', () => {
    const out = capAtBoundary('😀'.repeat(30), 10);
    expect(Array.from(out).length).toBeLessThanOrEqual(10);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
