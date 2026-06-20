import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime, formatTime, withUserTimeFormatOptions } from './dateTimeFormat';

let authState: { user: { preferences?: { timeFormat?: '12h' | '24h' } } | null } = { user: null };

vi.mock('../stores/auth', () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

const baseUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'User One',
  mfaEnabled: false,
};

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
    authState = { user: null };
    window.localStorage.clear();
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

  it('uses the authenticated user preference when no explicit timeFormat is provided', () => {
    authState = {
      user: { ...baseUser, preferences: { timeFormat: '24h' } },
    };

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
