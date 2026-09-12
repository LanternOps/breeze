import { describe, expect, it } from 'vitest';
import { tServer, serverBundleLocales } from './server';

describe('tServer', () => {
  it('resolves an English key', () => {
    expect(tServer('en', 'titles.devices')).toBe('Devices');
  });

  it('resolves a translated key for a non-English locale', () => {
    expect(tServer('pt-BR', 'titles.devices')).toBe('Dispositivos');
  });

  it('falls back to English when the locale is undefined', () => {
    expect(tServer(undefined, 'titles.settings')).toBe('Settings');
  });

  it('returns the raw key when it exists in no locale', () => {
    expect(tServer('en', 'titles.doesNotExist')).toBe('titles.doesNotExist');
  });

  it('interpolates a {{var}} placeholder against the raw-key fallback', () => {
    // No shipped pages.json key needs interpolation today, so this exercises
    // the replace() contract directly: an unresolved key falls back to the
    // dot-path string itself, and {{var}} inside it still gets filled.
    expect(tServer('en', 'greeting.hello {{name}}', { name: 'Ada' })).toBe(
      'greeting.hello Ada',
    );
  });

  it('leaves an unresolved placeholder intact', () => {
    expect(tServer('en', 'greeting.hi {{missing}}', {})).toBe('greeting.hi {{missing}}');
  });

  it('nests through multiple dot-path segments', () => {
    expect(tServer('en', 'errorPage.dashboardLink')).toBe('Go to dashboard');
    expect(tServer('pt-BR', 'errorPage.dashboardLink')).toBe('Ir para o painel');
  });

  it('discovers every supported locale bundle', () => {
    expect(serverBundleLocales).toEqual(
      ['de-DE', 'en', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'].sort(),
    );
  });
});
