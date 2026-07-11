import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, loadLocale, setLocale } from './index';
import { LOCALE_STORAGE_KEY } from '../appearance';

describe('i18n runtime (namespaced, lazy locales)', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('initializes synchronously with English', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });

  it('auto-registers every en namespace file', () => {
    expect(i18n.hasResourceBundle('en', 'common')).toBe(true);
    expect(i18n.hasResourceBundle('en', 'settings')).toBe(true);
  });

  it('lazy-loads pt-BR and translates after setLocale', async () => {
    setLocale('pt-BR');
    await loadLocale('pt-BR');
    await vi.waitFor(() => expect(i18n.language).toBe('pt-BR'));
    expect(i18n.t('nav.dashboard')).toBe('Painel');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
  });

  it('resolves cross-namespace keys with explicit ns prefix', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    expect(i18n.t('settings:language.title')).toBe('Idioma');
  });
});
