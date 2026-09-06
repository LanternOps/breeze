import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n, loadLocale } from './i18n';
import { formatTimeAgo, formatTimeUntil } from './formatTime';

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

describe('formatTimeAgo invalid input', () => {
  it('returns a placeholder instead of throwing on an unparseable timestamp', () => {
    expect(formatTimeAgo('not-a-date')).toBe('—');
  });
});

describe('formatTimeUntil', () => {
  const NOW = new Date('2026-09-05T12:00:00Z');

  it('counts forward in days, hours and minutes', () => {
    expect(formatTimeUntil('2026-09-08T12:00:00Z', NOW)).toBe('in 3 days');
    expect(formatTimeUntil('2026-09-05T17:00:00Z', NOW)).toBe('in 5 hours');
    expect(formatTimeUntil('2026-09-05T12:20:00Z', NOW)).toBe('in 20 minutes');
  });

  it('floors at a minute rather than saying "now" about a window still open', () => {
    expect(formatTimeUntil('2026-09-05T12:00:10Z', NOW)).toBe('in 1 minute');
  });

  it('returns null once the instant has passed, so callers can drop the deadline', () => {
    expect(formatTimeUntil('2026-09-05T11:59:00Z', NOW)).toBeNull();
    expect(formatTimeUntil('2026-09-05T12:00:00Z', NOW)).toBeNull();
  });

  it('returns null on an unparseable timestamp instead of throwing', () => {
    // Intl.RelativeTimeFormat.format(NaN) throws — a bad stamp must not take
    // the device page down.
    expect(formatTimeUntil('not-a-date', NOW)).toBeNull();
  });

  it('formats in the active locale', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    try {
      expect(formatTimeUntil('2026-09-08T12:00:00Z', NOW)).toBe('em 3 dias');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
