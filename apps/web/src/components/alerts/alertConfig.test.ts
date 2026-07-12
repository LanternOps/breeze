import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, loadLocale } from '@/lib/i18n';

import { formatRelativeTime } from './alertConfig';

describe('formatRelativeTime', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await i18n.changeLanguage('en');
  });

  it('localizes compact alert ages in Brazilian Portuguese', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');

    expect(formatRelativeTime('2026-07-11T11:55:00.000Z')).toBe('há 5 min');
    expect(formatRelativeTime('2026-07-11T10:00:00.000Z')).toBe('há 2 h');
    expect(formatRelativeTime('2026-07-09T12:00:00.000Z')).toBe('há 2 d');
  });
});
