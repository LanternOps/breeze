import { describe, it, expect } from 'vitest';
import { escapeLike } from './sql';

describe('escapeLike', () => {
  it('escapes percent wildcards', () => {
    expect(escapeLike('100%')).toBe('100\\%');
  });

  it('escapes underscore wildcards', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes backslash so a trailing backslash cannot escape a following wildcard', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    // Regression for #99: a lone trailing backslash must be escaped, otherwise
    // `%${escapeLike(s)}%` would let the input's `\` escape the closing `%`.
    expect(escapeLike('foo\\')).toBe('foo\\\\');
  });

  it('escapes all special characters together', () => {
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
  });

  it('leaves plain text untouched', () => {
    expect(escapeLike('plain text 123')).toBe('plain text 123');
  });

  it('returns empty string for empty input', () => {
    expect(escapeLike('')).toBe('');
  });
});
