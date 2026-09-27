import { describe, expect, it } from 'vitest';
import { OWNER_USERNAME_PATTERN, escapeLikeLiteral, ownerRelPathPattern } from './ownerPath';

describe('ownerPath', () => {
  it('escapes backslash, percent and underscore (backslash first)', () => {
    expect(escapeLikeLiteral('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
    expect(escapeLikeLiteral('Dana K')).toBe('Dana K');
  });

  it('builds a literal-prefix pattern for the claimed profile', () => {
    expect(ownerRelPathPattern('alice')).toBe('alice/%');
    expect(ownerRelPathPattern('a_ice')).toBe('a\\_ice/%');
    expect(ownerRelPathPattern('%')).toBe('\\%/%');
  });

  it('allows real profile names and refuses separators, % and control characters', () => {
    for (const ok of ['alice', 'a_ice', 'Dana K', 'john.CONTOSO.000', "o'brien", 'J\u00fcrgen', '']) {
      expect(OWNER_USERNAME_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['%', 'a/b', 'a\\b', 'a\u0000b', 'a\nb', 'a\u007fb']) {
      expect(OWNER_USERNAME_PATTERN.test(bad)).toBe(false);
    }
  });
});
