import { describe, expect, it } from 'vitest';
import {
  parseAcceptLanguage,
  resolveLocaleFromAcceptLanguage,
  resolveLocaleFromCookie,
  resolveServerLocale,
} from './serverLocale';

describe('parseAcceptLanguage', () => {
  it('orders tags by descending quality', () => {
    expect(parseAcceptLanguage('fr-FR;q=0.5, en-US;q=0.9, de-DE;q=0.7')).toEqual([
      'en-US',
      'de-DE',
      'fr-FR',
    ]);
  });

  it('defaults an unlabeled tag to quality 1', () => {
    expect(parseAcceptLanguage('fr-FR;q=0.9, en-US')).toEqual(['en-US', 'fr-FR']);
  });

  it('keeps source order among equal-quality tags', () => {
    expect(parseAcceptLanguage('pt-BR,es-419,en')).toEqual(['pt-BR', 'es-419', 'en']);
  });

  it('drops q=0 entries, the * wildcard, and malformed tags', () => {
    expect(parseAcceptLanguage('en;q=0, *, not a tag!, pt-BR')).toEqual(['pt-BR']);
  });

  it('returns an empty array for null, undefined, or blank input', () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage('   ')).toEqual([]);
  });

  it('caps a pathological header at 20 entries', () => {
    const header = Array.from({ length: 30 }, (_, i) => `xx-${i}`).join(',');
    expect(parseAcceptLanguage(header)).toHaveLength(20);
  });
});

describe('resolveLocaleFromAcceptLanguage', () => {
  it('matches an exact supported tag case-insensitively', () => {
    expect(resolveLocaleFromAcceptLanguage('PT-br')).toBe('pt-BR');
  });

  it('falls back to a base-language match for an unsupported region', () => {
    expect(resolveLocaleFromAcceptLanguage('pt-PT')).toBe('pt-BR');
    expect(resolveLocaleFromAcceptLanguage('es-MX')).toBe('es-419');
    expect(resolveLocaleFromAcceptLanguage('fr-BE')).toBe('fr-FR');
  });

  it('picks the first resolvable tag in quality order', () => {
    expect(resolveLocaleFromAcceptLanguage('xx-XX;q=0.9, de-DE;q=0.5')).toBe('de-DE');
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveLocaleFromAcceptLanguage('xx-XX, yy-YY')).toBeUndefined();
    expect(resolveLocaleFromAcceptLanguage(null)).toBeUndefined();
    expect(resolveLocaleFromAcceptLanguage(undefined)).toBeUndefined();
  });
});

describe('resolveLocaleFromCookie', () => {
  it('accepts any of the 8 supported locales', () => {
    for (const locale of ['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR']) {
      expect(resolveLocaleFromCookie(locale)).toBe(locale);
    }
  });

  it('rejects unsupported or missing values', () => {
    expect(resolveLocaleFromCookie('fr')).toBeUndefined();
    expect(resolveLocaleFromCookie('klingon')).toBeUndefined();
    expect(resolveLocaleFromCookie(undefined)).toBeUndefined();
  });
});

describe('resolveServerLocale', () => {
  it('prefers the cookie over Accept-Language', () => {
    expect(
      resolveServerLocale({ cookieValue: 'de-DE', acceptLanguage: 'pt-BR' }),
    ).toBe('de-DE');
  });

  it('falls back to Accept-Language when the cookie is absent', () => {
    expect(
      resolveServerLocale({ cookieValue: undefined, acceptLanguage: 'fr-FR,fr;q=0.9' }),
    ).toBe('fr-FR');
  });

  it('falls back to Accept-Language when the cookie is invalid', () => {
    expect(
      resolveServerLocale({ cookieValue: 'klingon', acceptLanguage: 'it-IT' }),
    ).toBe('it-IT');
  });

  it('returns undefined when neither source resolves', () => {
    expect(resolveServerLocale({})).toBeUndefined();
    expect(
      resolveServerLocale({ cookieValue: 'klingon', acceptLanguage: 'xx-XX' }),
    ).toBeUndefined();
  });
});
