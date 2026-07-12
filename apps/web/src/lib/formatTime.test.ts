import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, loadLocale } from './i18n';
import { formatTimeAgo } from './formatTime';

describe('formatTimeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await i18n.changeLanguage('en');
  });

  it('formats dashboard relative times in Brazilian Portuguese', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');

    expect(formatTimeAgo('2026-07-11T11:56:00Z')).toBe('há 4 minutos');
    expect(formatTimeAgo('2026-07-11T11:58:00Z')).toBe('há 2 minutos');
  });
});
