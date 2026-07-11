import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocale, i18n, loadLocale, setLocale } from './index';
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

  it('memoizes concurrent loads for the same locale', async () => {
    const first = loadLocale('pt-BR');
    const second = loadLocale('pt-BR');

    expect(second).toBe(first);
    await first;
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

  it('keeps the last locale request when an earlier loader resolves later', async () => {
    let resolvePortuguese!: () => void;
    const portugueseLoad = new Promise<void>(resolve => {
      resolvePortuguese = resolve;
    });
    const changeLanguage = vi.fn(async () => undefined);
    const dependencies = {
      loadLocale: vi.fn((locale: 'en' | 'pt-BR') =>
        locale === 'pt-BR' ? portugueseLoad : Promise.resolve()
      ),
      changeLanguage,
    };

    const earlier = applyLocale('pt-BR', dependencies);
    const latest = applyLocale('en', dependencies);
    await latest;
    resolvePortuguese();
    await earlier;

    expect(changeLanguage).toHaveBeenCalledTimes(1);
    expect(changeLanguage).toHaveBeenCalledWith('en');
  });

  it('ignores a stale loader rejection without an English rollback', async () => {
    let rejectPortuguese!: (error: Error) => void;
    const portugueseLoad = new Promise<void>((_resolve, reject) => {
      rejectPortuguese = reject;
    });
    const changeLanguage = vi.fn(async () => undefined);
    const dependencies = {
      loadLocale: vi.fn((locale: 'en' | 'pt-BR') =>
        locale === 'pt-BR' ? portugueseLoad : Promise.resolve()
      ),
      changeLanguage,
    };

    const earlier = applyLocale('pt-BR', dependencies);
    const latest = applyLocale('en', dependencies);
    await latest;
    rejectPortuguese(new Error('chunk unavailable'));
    await expect(earlier).resolves.toBeUndefined();

    expect(changeLanguage).toHaveBeenCalledTimes(1);
    expect(changeLanguage).toHaveBeenCalledWith('en');
  });

  it('falls back to English when the latest locale loader rejects', async () => {
    const changeLanguage = vi.fn(async () => undefined);
    const dependencies = {
      loadLocale: vi.fn((locale: 'en' | 'pt-BR') =>
        locale === 'pt-BR'
          ? Promise.reject(new Error('chunk unavailable'))
          : Promise.resolve()
      ),
      changeLanguage,
    };

    await expect(applyLocale('pt-BR', dependencies)).resolves.toBeUndefined();

    expect(dependencies.loadLocale).toHaveBeenNthCalledWith(1, 'pt-BR');
    expect(dependencies.loadLocale).toHaveBeenNthCalledWith(2, 'en');
    expect(changeLanguage).toHaveBeenCalledOnce();
    expect(changeLanguage).toHaveBeenCalledWith('en');
  });
});
