import { describe, expect, it } from 'vitest';
import { isSupportedLocale, SUPPORTED_LOCALES } from './locale';

describe('SUPPORTED_LOCALES', () => {
  it('lists every supported runtime locale', () => {
    expect(SUPPORTED_LOCALES).toHaveLength(8);
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(SUPPORTED_LOCALES).toContain('tr-TR');
  });
});

describe('isSupportedLocale', () => {
  it('accepts only exact supported locale strings', () => {
    expect(isSupportedLocale('fr-CA')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});
