import { describe, it, expect } from 'vitest';
import { generateUniqueSlug, slugify } from './slug';

describe('slugify', () => {
  it('lowercases, strips punctuation, hyphenates spaces', () => {
    expect(slugify('Acme Co., Inc.')).toBe('acme-co-inc');
    expect(slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
  });
  it('falls back to "org" for empty/punctuation-only input', () => {
    expect(slugify('!!!')).toBe('org');
    expect(slugify('')).toBe('org');
  });
});

describe('generateUniqueSlug', () => {
  it('returns the base when free', () => {
    expect(generateUniqueSlug('acme', new Set())).toBe('acme');
  });
  it('appends an incrementing suffix on collision', () => {
    expect(generateUniqueSlug('acme', new Set(['acme', 'acme-2']))).toBe('acme-3');
  });
});
