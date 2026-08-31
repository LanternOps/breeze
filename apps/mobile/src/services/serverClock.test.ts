import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  },
}));

import {
  loadServerClock,
  noteServerDate,
  resetServerClock,
  serverNowMs,
  SERVER_CLOCK_KEY,
} from './serverClock';

beforeEach(() => {
  store.clear();
  resetServerClock();
  vi.useFakeTimers();
  // The device clock is three hours fast; the server is the truth.
  vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('serverClock', () => {
  it('reports the device clock, untrusted, before any anchor is seen', () => {
    expect(serverNowMs()).toEqual({ ms: Date.parse('2026-08-30T12:00:00.000Z'), trusted: false });
  });

  it('corrects the device clock once a Date header has been seen', () => {
    noteServerDate('Sun, 30 Aug 2026 09:00:00 GMT');
    expect(serverNowMs()).toEqual({ ms: Date.parse('2026-08-30T09:00:00.000Z'), trusted: true });
  });

  it('keeps correcting while the phone is offline, because it stores an offset', () => {
    noteServerDate('Sun, 30 Aug 2026 09:00:00 GMT');
    vi.setSystemTime(new Date('2026-08-30T12:40:00.000Z'));
    // 40 device-minutes later, so 40 server-minutes later — not a frozen stamp.
    expect(serverNowMs().ms).toBe(Date.parse('2026-08-30T09:40:00.000Z'));
  });

  it('ignores a missing or unparseable header rather than poisoning the offset', () => {
    noteServerDate(null);
    expect(serverNowMs().trusted).toBe(false);
    noteServerDate('not a date');
    expect(serverNowMs().trusted).toBe(false);
  });

  it('rehydrates the offset a previous launch persisted', async () => {
    noteServerDate('Sun, 30 Aug 2026 09:00:00 GMT');
    expect(store.has(SERVER_CLOCK_KEY)).toBe(true);

    resetServerClock();
    expect(serverNowMs().trusted).toBe(false);
    await loadServerClock();
    expect(serverNowMs()).toEqual({ ms: Date.parse('2026-08-30T09:00:00.000Z'), trusted: true });
  });

  it('treats a corrupt persisted anchor as no anchor', async () => {
    store.set(SERVER_CLOCK_KEY, '{not json');
    await loadServerClock();
    expect(serverNowMs().trusted).toBe(false);
  });
});
