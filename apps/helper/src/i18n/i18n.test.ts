import { describe, expect, it } from 'vitest';

import { copyFor } from '../windows/callerVerifyMessages';
import { CATALOG_LOCALES, catalogLocaleFor, englishCatalog, resolveLocale, translate } from './index';
import ptBR from '../locales/pt-BR.json';

const params = (s: string) => [...s.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort();

describe('Helper catalogs', () => {
  it('ships the canonical English catalog and at least one non-English catalog', () => {
    expect(CATALOG_LOCALES).toContain('en');
    expect(CATALOG_LOCALES.filter((l) => l !== 'en').length).toBeGreaterThanOrEqual(1);
  });

  it('every non-English catalog has exactly the English keys and the same placeholders', () => {
    const en = englishCatalog as Record<string, string>;
    const pt = ptBR as Record<string, string>;
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(params(pt[key]!), key).toEqual(params(en[key]!));
  });
});

describe('locale selection and fallback', () => {
  it.each([
    ['pt-BR', 'pt-BR'],
    ['pt_BR.UTF-8', 'pt-BR'],
    ['pt', 'pt-BR'],
    ['pt-PT', 'pt-BR'],
  ])('%s uses the pt-BR catalog', (tag, expected) => {
    expect(catalogLocaleFor(tag)).toBe(expected);
    expect(translate('shell.nav.history', tag)).toBe('Histórico');
  });

  it.each(['de-DE', 'fr-CA', 'tr', 'xx-YY', '', 'en-US', '<script>', null, undefined])(
    '%s without a Helper catalog falls back to English deterministically',
    (tag) => {
      expect(catalogLocaleFor(tag as string)).toBe('en');
      expect(translate('shell.nav.history', tag as string)).toBe('History');
    },
  );

  it('a key missing from a locale falls back to English, then to the key', () => {
    expect(translate('nope.missing' as never, 'pt-BR')).toBe('nope.missing');
  });

  it('substitutes {name} once and leaves unknown placeholders literal', () => {
    expect(translate('onboarding.welcome', 'en', { name: '{name} {x}' })).toBe('Welcome to {name} {x}');
    expect(translate('onboarding.welcome', 'en')).toBe('Welcome to {name}');
  });

  it('negotiation is the shared one (eight locales)', () => {
    expect(resolveLocale('fr-CA')).toBe('fr-CA');
    expect(resolveLocale('de_AT')).toBe('de-DE');
  });
});

describe('Caller Verification uses the same session locale resolution', () => {
  it('maps tags through the shared negotiation; unknown is English', () => {
    expect(copyFor('pt_BR.UTF-8').title).toBe('Verificação de quem está ligando');
    expect(copyFor('fr-CA').title).toBe('Vérification de la personne qui appelle');
    expect(copyFor('xx').title).toBe('Caller verification');
  });
});
