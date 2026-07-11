import { beforeEach, describe, expect, it } from 'vitest';
import { i18n, setLocale } from './index';
import { LOCALE_STORAGE_KEY } from '../appearance';
import en from '../../locales/en/common.json';
import ptBR from '../../locales/pt-BR/common.json';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

describe('i18n runtime', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('initializes and translates in English by default', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });

  it('translates to pt-BR after setLocale and persists the preference', () => {
    setLocale('pt-BR');
    expect(i18n.language).toBe('pt-BR');
    expect(i18n.t('nav.dashboard')).toBe('Painel');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
  });

  it('falls back to a supplied English default for missing keys', () => {
    setLocale('pt-BR');
    expect(i18n.t('nav.dashboard', { defaultValue: 'Dashboard' })).toBe('Painel');
    expect(i18n.t('some.future.key', { defaultValue: 'Future thing' })).toBe('Future thing');
  });

  it('keeps pt-BR keys in exact parity with English', () => {
    expect(flattenKeys(ptBR).sort()).toEqual(flattenKeys(en).sort());
  });
});
