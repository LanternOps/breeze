import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTimeFormatPreference } from './appearance';
import { formatDateTime, formatRelativeTime, formatTime, withUserTimeFormatOptions } from './dateTimeFormat';

/**
 * Simulates the browser/OS reporting a given hour cycle via
 * `Intl.DateTimeFormat(undefined, ...).resolvedOptions().hourCycle` — the
 * same mechanism `detectBrowserTimeFormat` (appearance.ts) relies on. Only
 * calls made with an *undefined* locale (i.e. "ask the environment") are
 * redirected; calls with an explicit locale (what test assertions pass to
 * pin the rendered format) are left alone.
 */
function mockBrowserHourCycle(hourCycle: 'h23' | 'h12'): () => void {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  const localeForHourCycle = hourCycle === 'h23' ? 'de-DE' : 'en-US';
  const spy = vi
    .spyOn(Intl, 'DateTimeFormat')
    .mockImplementation(function (
      this: unknown,
      locale?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions
    ) {
      return new RealDateTimeFormat(locale === undefined ? localeForHourCycle : locale, options);
    });
  return () => spy.mockRestore();
}

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

describe('dateTimeFormat', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: makeMemoryStorage(),
      writable: true,
      configurable: true,
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats 24-hour time without AM/PM and with 00 for midnight', () => {
    const rendered = formatTime('2026-01-01T00:05:00.000Z', {
      locale: 'en-US',
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      timeFormat: '24h',
    });

    expect(rendered).toBe('00:05');
    expect(rendered).not.toMatch(/AM|PM/i);
  });

  it('formats 12-hour time with a day period', () => {
    expect(formatTime('2026-01-01T15:45:00.000Z', {
      locale: 'en-US',
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      timeFormat: '12h',
    })).toBe('3:45 PM');
  });

  it('falls through to browser-detected hour cycle when no preference is stored (#4231)', () => {
    const restore = mockBrowserHourCycle('h23');
    try {
      // No stored preference (localStorage cleared in beforeEach), no explicit
      // timeFormat — the browser/OS reports a 24h hour cycle, so the effective
      // format must be 24h, not fall back to the app UI locale's 12h default.
      expect(formatTime('2026-01-01T15:45:00.000Z', {
        locale: 'en-US',
        timeZone: 'UTC',
        hour: '2-digit',
        minute: '2-digit',
      })).toBe('15:45');
    } finally {
      restore();
    }
  });

  it('uses the saved appearance preference when no explicit timeFormat is provided', () => {
    writeTimeFormatPreference('24h');

    expect(formatDateTime('2026-01-01T15:45:00.000Z', {
      locale: 'en-US',
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })).toBe('Jan 1, 15:45');
  });

  it('does not apply hour-cycle options to date-only formatting', () => {
    expect(formatDateTime('2026-01-01T15:45:00.000Z', {
      locale: 'en-US',
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeFormat: '24h',
    })).toBe('Jan 1, 2026');
  });

  it('preserves caller fallback for missing or invalid dates', () => {
    expect(formatDateTime(null, { fallback: '--' })).toBe('--');
    expect(formatDateTime('not-a-date', { fallback: 'Unknown' })).toBe('Unknown');
  });

  it('overrides caller hour12 settings only when formatting includes time', () => {
    expect(withUserTimeFormatOptions({ hour: '2-digit', hour12: true }, '24h', 'dateTime'))
      .toEqual({ hour: '2-digit', hourCycle: 'h23' });
    expect(withUserTimeFormatOptions({ year: 'numeric', hour12: true }, '24h', 'dateTime'))
      .toEqual({ year: 'numeric', hour12: true });
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');

  it('renders recent timestamps in minutes and hours', () => {
    expect(formatRelativeTime('2026-09-08T11:58:00.000Z', { now, locale: 'en-US' })).toBe('2 minutes ago');
    expect(formatRelativeTime('2026-09-08T09:00:00.000Z', { now, locale: 'en-US' })).toBe('3 hours ago');
  });

  it('renders older timestamps in days', () => {
    expect(formatRelativeTime('2026-09-05T12:00:00.000Z', { now, locale: 'en-US' })).toBe('3 days ago');
  });

  it('treats anything under a minute as just now', () => {
    expect(formatRelativeTime('2026-09-08T11:59:40.000Z', { now, locale: 'en-US' })).toBe('now');
  });

  it('returns the fallback for an unparseable or null value', () => {
    expect(formatRelativeTime(null, { now, fallback: '—' })).toBe('—');
    expect(formatRelativeTime('not a date', { now, fallback: '—' })).toBe('—');
  });
});
