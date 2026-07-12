import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLocale,
  i18n,
  loadLocale,
  scheduleStoredLocaleAfterHydration,
  setLocale,
  syncDocumentLocaleMetadata,
} from './index';
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

  it('defers the stored locale until Astro finishes initial hydration', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    let scheduledTask: (() => void) | undefined;

    scheduleStoredLocaleAfterHydration(task => {
      scheduledTask = task;
    });

    expect(i18n.language).toBe('en');
    expect(scheduledTask).toBeTypeOf('function');

    scheduledTask?.();

    await vi.waitFor(() => expect(i18n.language).toBe('pt-BR'));
    expect(i18n.t('nav.dashboard')).toBe('Painel');
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

  it('synchronizes the document language and localized page title', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');

    // The languageChanged listener updates the currently loaded page.
    expect(document.documentElement.lang).toBe('pt-BR');
    expect(document.title).toBe('Painel | Breeze RMM');

    // Astro page-load uses the same synchronizer after client navigation.
    syncDocumentLocaleMetadata('/settings/profile', document);
    expect(document.title).toBe('Configurações de perfil | Breeze RMM');

    syncDocumentLocaleMetadata('/remote', document);
    expect(document.title).toBe('Acesso Remoto | Breeze RMM');

    syncDocumentLocaleMetadata('/vulnerabilities', document);
    expect(document.title).toBe('Vulnerabilidades | Breeze RMM');
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
    await expect(latest).resolves.toEqual({ locale: 'en', usedFallback: false });
    resolvePortuguese();
    // The superseded request's own load never throws, so it reports its own
    // outcome as a non-fallback success even though the newer 'en' request
    // is the one that actually won the race (see the JSDoc on applyLocale).
    await expect(earlier).resolves.toEqual({ locale: 'pt-BR', usedFallback: false });

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
    await expect(latest).resolves.toEqual({ locale: 'en', usedFallback: false });
    rejectPortuguese(new Error('chunk unavailable'));
    // Superseded before its own failure landed: the earlier request defers
    // to the newer one entirely and does not dispatch its own fallback.
    await expect(earlier).resolves.toEqual({ locale: 'pt-BR', usedFallback: false });

    expect(changeLanguage).toHaveBeenCalledTimes(1);
    expect(changeLanguage).toHaveBeenCalledWith('en');
  });

  it('falls back to English when the latest locale loader rejects, and reports the wrapped error', async () => {
    const changeLanguage = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const dependencies = {
      loadLocale: vi.fn((locale: 'en' | 'pt-BR') =>
        locale === 'pt-BR'
          ? Promise.reject(new Error('chunk unavailable'))
          : Promise.resolve()
      ),
      changeLanguage,
      reportError,
    };

    await expect(applyLocale('pt-BR', dependencies)).resolves.toEqual({
      locale: 'pt-BR',
      usedFallback: true,
    });

    expect(dependencies.loadLocale).toHaveBeenNthCalledWith(1, 'pt-BR');
    expect(dependencies.loadLocale).toHaveBeenNthCalledWith(2, 'en');
    expect(changeLanguage).toHaveBeenCalledOnce();
    expect(changeLanguage).toHaveBeenCalledWith('en');

    // FIX 1: the raw chunk-load error is wrapped in a distinct message before
    // reaching reportError, since Sentry's ignoreErrors filters the raw
    // "Failed to fetch dynamically imported module" message by text.
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reportedError, reportedLocale] = reportError.mock.calls[0];
    expect(reportedError).toBeInstanceOf(Error);
    expect((reportedError as Error).message).toBe('i18n: failed to load locale "pt-BR"');
    expect((reportedError as Error).cause).toBeInstanceOf(Error);
    expect(reportedLocale).toBe('pt-BR');
  });

  it('reports both the original failure and the fallback failure when English also fails to load, without an unhandled rejection', async () => {
    const changeLanguage = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const dependencies = {
      loadLocale: vi.fn((locale: 'en' | 'pt-BR') =>
        Promise.reject(new Error(`${locale} chunk unavailable`))
      ),
      changeLanguage,
      reportError,
    };

    await expect(applyLocale('pt-BR', dependencies)).resolves.toEqual({
      locale: 'pt-BR',
      usedFallback: true,
    });

    expect(changeLanguage).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(2);

    const [firstError, firstLocale] = reportError.mock.calls[0];
    expect((firstError as Error).message).toBe('i18n: failed to load locale "pt-BR"');
    expect(firstLocale).toBe('pt-BR');

    const [secondError, secondLocale] = reportError.mock.calls[1];
    expect((secondError as Error).message).toBe('i18n: fallback to English failed');
    expect((secondError as Error).cause).toBeInstanceOf(Error);
    expect(secondLocale).toBe('en');
  });

  it('reports a missing key handler invocation at most once per key per session', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const missingKey = `__i18nTelemetryMissingKeyTest_${Date.now()}_${Math.random()}`;

    i18n.t(missingKey);
    i18n.t(missingKey);
    i18n.t(missingKey);

    const matches = warnSpy.mock.calls.filter(call => String(call[0]).includes(missingKey));
    expect(matches).toHaveLength(1);
    expect(matches[0][0]).toBe(`[i18n] missing key: common:${missingKey}`);

    warnSpy.mockRestore();
  });

  describe('scheduleAfterAstroHydration (real implementation, not the injected stand-in)', () => {
    afterEach(() => {
      for (const island of document.querySelectorAll('astro-island')) {
        island.remove();
      }
    });

    it('runs the task immediately when there are no pending islands', async () => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');

      scheduleStoredLocaleAfterHydration();

      await vi.waitFor(() => expect(i18n.language).toBe('pt-BR'));
    });

    it('defers the task until the last pending island finishes hydrating', async () => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');

      const island = document.createElement('astro-island');
      island.setAttribute('ssr', '');
      island.setAttribute('client', 'load');
      document.body.appendChild(island);

      scheduleStoredLocaleAfterHydration();

      // Still pending: the task must not have run yet.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(i18n.language).toBe('en');

      // Astro removes the `ssr` marker once the island finishes hydrating.
      island.removeAttribute('ssr');

      await vi.waitFor(() => expect(i18n.language).toBe('pt-BR'));
    });
  });

  describe('cross-island propagation', () => {
    it('re-renders every independently-mounted React root sharing the i18next singleton on changeLanguage', async () => {
      function DashboardLabel() {
        const { t } = useTranslation('common');
        return createElement('span', { 'data-testid': 'label' }, t('nav.dashboard'));
      }

      const containerA = document.createElement('div');
      const containerB = document.createElement('div');
      document.body.appendChild(containerA);
      document.body.appendChild(containerB);
      const rootA = createRoot(containerA);
      const rootB = createRoot(containerB);

      try {
        await act(async () => {
          rootA.render(createElement(DashboardLabel));
          rootB.render(createElement(DashboardLabel));
        });

        expect(containerA.textContent).toBe('Dashboard');
        expect(containerB.textContent).toBe('Dashboard');

        await loadLocale('pt-BR');
        await act(async () => {
          await i18n.changeLanguage('pt-BR');
        });

        expect(containerA.textContent).toBe('Painel');
        expect(containerB.textContent).toBe('Painel');
      } finally {
        act(() => {
          rootA.unmount();
          rootB.unmount();
        });
        containerA.remove();
        containerB.remove();
      }
    });
  });
});
