import { beforeEach, describe, expect, it } from 'vitest';
import { formatCurrency, formatNumber, formatPercent } from './format';
import { applyLocale, i18n, loadLocale } from './index';
import { LOCALE_STORAGE_KEY } from '../appearance';
import { formatDate } from '../dateTimeFormat';

const NBSP = ' ';

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

describe('locale-aware number formatting', () => {
  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', {
      value: makeMemoryStorage(),
      writable: true,
      configurable: true,
    });
    window.localStorage.clear();
    await applyLocale('en');
  });

  it('formats with pt-BR separators when the preference is set', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1.234,50');
    expect(formatCurrency(1234.5, 'BRL')).toBe(`R$${NBSP}1.234,50`);
    expect(formatPercent(0.425, { maximumFractionDigits: 1 })).toBe('42,5%');
  });

  it('formats with en separators when the preference is en', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1,234.50');
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('falls through to the runtime default locale when no preference is set', () => {
    // No stored preference: must not throw, must return a formatted string.
    expect(typeof formatNumber(1234.5)).toBe('string');
  });

  it('uses the resolved partner/browser locale when no explicit preference is stored', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1.234,50');
  });

  it('uses the active English runtime after a pt-BR chunk load fails', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1.234,50');

    await applyLocale('pt-BR', {
      loadLocale: (locale) => locale === 'pt-BR'
        ? Promise.reject(new Error('chunk unavailable'))
        : Promise.resolve(),
      changeLanguage: (locale) => i18n.changeLanguage(locale),
    });

    expect(i18n.language).toBe('en');
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1,234.50');
    expect(formatDate('2026-03-09T12:00:00Z', { timeZone: 'UTC' })).toBe('3/9/2026');
  });
});

describe('dateTimeFormat honors the resolved locale', () => {
  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', {
      value: makeMemoryStorage(),
      writable: true,
      configurable: true,
    });
    window.localStorage.clear();
    await applyLocale('en');
  });

  it('renders pt-BR date order when the preference is set', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    // 2026-03-09 → pt-BR is day-first
    expect(formatDate('2026-03-09T12:00:00Z', { timeZone: 'UTC' })).toBe('09/03/2026');
  });

  it('explicit locale option still wins', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    expect(formatDate('2026-03-09T12:00:00Z', { locale: 'en-US', timeZone: 'UTC' })).toBe('3/9/2026');
  });

  it('uses the resolved partner/browser locale when no explicit preference is stored', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    expect(formatDate('2026-03-09T12:00:00Z', { timeZone: 'UTC' })).toBe('09/03/2026');
  });
});
