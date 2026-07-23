import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  LOCALE_OPTIONS,
  LOCALE_STORAGE_KEY,
  PARTNER_LOCALE_STORAGE_KEY,
  isValidLocale,
  normalizeLocale,
  readLocalePreference,
  readPartnerLocalePreference,
  detectBrowserLocale,
  readResolvedLocalePreference,
  writeLocalePreference,
  writePartnerLocalePreference,
  applyResolvedLocalePreferences,
  subscribeLocale,
  applyAppearancePreferences,
} from '../appearance';

describe('locale preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes exactly the supported locales', () => {
expect(LOCALE_OPTIONS).toEqual(['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT']);
      expect(isValidLocale(locale)).toBe(true);
      expect(normalizeLocale(locale)).toBe(locale);
    }
    expect(isValidLocale('fr')).toBe(false);
    expect(isValidLocale('de-AT')).toBe(false);
    expect(isValidLocale(42)).toBe(false);
    expect(normalizeLocale('junk')).toBeUndefined();
  });

  it.each([
    ['es-MX', 'es-419'],
    ['fr-CA', 'fr-CA'],
    ['fr-BE', 'fr-FR'],
    ['de-AT', 'de-DE'],
    ['it-CH', 'it-IT'],
  ] as const)('maps browser locale %s to %s', (browserLocale, expected) => {
    vi.stubGlobal('navigator', { languages: [browserLocale], language: browserLocale });
    expect(detectBrowserLocale()).toBe(expected);
  });

  it('round-trips through localStorage', () => {
    expect(readLocalePreference()).toBeUndefined();
    writeLocalePreference('pt-BR');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
    expect(readLocalePreference()).toBe('pt-BR');
  });

  it('ignores garbage in localStorage', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    expect(readLocalePreference()).toBeUndefined();
  });

  it('detects pt-BR from navigator, including base-language pt', () => {
    vi.stubGlobal('navigator', { languages: ['pt-BR', 'en'], language: 'pt-BR' });
    expect(detectBrowserLocale()).toBe('pt-BR');
    vi.stubGlobal('navigator', { languages: ['pt', 'en'], language: 'pt' });
    expect(detectBrowserLocale()).toBe('pt-BR');
    vi.stubGlobal('navigator', { languages: ['PT-PT'], language: 'PT-PT' });
    expect(detectBrowserLocale()).toBe('pt-BR');
    vi.stubGlobal('navigator', { languages: ['en-GB'], language: 'en-GB' });
    expect(detectBrowserLocale()).toBe('en');
    vi.stubGlobal('navigator', { languages: ['ja-JP'], language: 'ja-JP' });
    expect(detectBrowserLocale()).toBe('en');
  });

  it('resolves stored preference over browser detection', () => {
    vi.stubGlobal('navigator', { languages: ['pt-BR'], language: 'pt-BR' });
    expect(readResolvedLocalePreference()).toBe('pt-BR');
    writeLocalePreference('en');
    expect(readResolvedLocalePreference()).toBe('en');
  });

  it('resolves user preference over partner default over browser locale', () => {
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    writePartnerLocalePreference('pt-BR');
    expect(readPartnerLocalePreference()).toBe('pt-BR');
    expect(readResolvedLocalePreference()).toBe('pt-BR');

    writeLocalePreference('en');
    expect(readResolvedLocalePreference()).toBe('en');
  });

  it('synchronizes authenticated locale state without leaking a previous user choice', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    expect(applyResolvedLocalePreferences(undefined, 'pt-BR')).toBe('pt-BR');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(PARTNER_LOCALE_STORAGE_KEY)).toBe('pt-BR');

    expect(applyResolvedLocalePreferences('en', 'pt-BR')).toBe('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('clears a stale partner default and falls back to the browser', () => {
    vi.stubGlobal('navigator', { languages: ['pt-BR'], language: 'pt-BR' });
    writePartnerLocalePreference('en');
    writePartnerLocalePreference(undefined);
    expect(window.localStorage.getItem(PARTNER_LOCALE_STORAGE_KEY)).toBeNull();
    expect(readResolvedLocalePreference()).toBe('pt-BR');
  });

  it('notifies subscribers on write and supports unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLocale((v) => seen.push(v));
    writeLocalePreference('pt-BR');
    expect(seen).toEqual(['pt-BR']);
    unsubscribe();
    writeLocalePreference('en');
    expect(seen).toEqual(['pt-BR']);
  });

  it('applyAppearancePreferences applies locale when present', () => {
    applyAppearancePreferences({ locale: 'pt-BR' });
    expect(readLocalePreference()).toBe('pt-BR');
    applyAppearancePreferences({});
    expect(readLocalePreference()).toBe('pt-BR'); // untouched when absent
  });
});
