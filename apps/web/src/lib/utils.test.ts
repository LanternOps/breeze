import { describe, it, expect } from 'vitest';

import { plural } from './utils';

describe('plural', () => {
  it('uses the singular form for exactly 1', () => {
    expect(plural(1, 'device')).toBe('1 device');
    expect(plural(1, 'finding')).toBe('1 finding');
  });

  it('adds an s for 0 and many', () => {
    expect(plural(0, 'device')).toBe('0 devices');
    expect(plural(3, 'finding')).toBe('3 findings');
  });

  it('supports an explicit plural form for irregular nouns', () => {
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
  });
});
