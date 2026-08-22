import { describe, it, expect } from 'vitest';
import { resolvePartnerDocumentLocale } from './documentLocale';

describe('resolvePartnerDocumentLocale', () => {
  it('returns the partner language when it is a supported locale', () => {
    expect(resolvePartnerDocumentLocale({ settings: { language: 'de-DE' } })).toBe('de-DE');
    expect(resolvePartnerDocumentLocale({ settings: { language: 'fr-CA' } })).toBe('fr-CA');
  });

  it('falls back to en for an unsupported language tag', () => {
    expect(resolvePartnerDocumentLocale({ settings: { language: 'xx' } })).toBe('en');
  });

  it('falls back to en for non-string language values', () => {
    expect(resolvePartnerDocumentLocale({ settings: { language: 42 } })).toBe('en');
    expect(resolvePartnerDocumentLocale({ settings: { language: null } })).toBe('en');
  });

  it('falls back to en when settings is null', () => {
    expect(resolvePartnerDocumentLocale({ settings: null })).toBe('en');
  });

  it('falls back to en when settings is a non-object', () => {
    expect(resolvePartnerDocumentLocale({ settings: 'de-DE' })).toBe('en');
  });

  it('falls back to en for a partner row without settings (unit-fixture shape)', () => {
    expect(resolvePartnerDocumentLocale({})).toBe('en');
  });

  it('falls back to en for a missing partner', () => {
    expect(resolvePartnerDocumentLocale(undefined)).toBe('en');
    expect(resolvePartnerDocumentLocale(null)).toBe('en');
  });
});
