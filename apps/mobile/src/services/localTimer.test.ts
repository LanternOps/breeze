import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  clearLocalTimer,
  currentMonoEpochId,
  LOCAL_TIMER_KEY,
  readLocalTimer,
  stampNow,
  writeLocalTimer,
  type LocalTimer,
} from './localTimer';

const timer: LocalTimer = {
  localId: 'l1',
  ticketId: 'k1',
  serverEntryId: null,
  startedAtWall: '2026-08-30T09:00:00.000Z',
  startedAtMono: 1234,
  monoEpochId: 'launch-1',
  startConfirmed: true,
  description: null,
};

beforeEach(() => {
  store.clear();
});

describe('localTimer', () => {
  it('round-trips a timer through storage', async () => {
    await writeLocalTimer(timer);
    await expect(readLocalTimer()).resolves.toEqual(timer);
    await clearLocalTimer();
    await expect(readLocalTimer()).resolves.toBeNull();
  });

  it('treats a persisted row with no startConfirmed as UNconfirmed', async () => {
    // The safe direction: an extra getRunningTimer() call costs one request,
    // where assuming "confirmed" leaves a real server timer running forever.
    store.set(
      LOCAL_TIMER_KEY,
      JSON.stringify({ localId: 'l1', startedAtWall: '2026-08-30T09:00:00.000Z' })
    );
    const read = await readLocalTimer();
    expect(read?.startConfirmed).toBe(false);
  });

  it('rejects a row with no usable start time rather than ticking from NaN', async () => {
    store.set(LOCAL_TIMER_KEY, JSON.stringify({ localId: 'l1', startedAtWall: 'nonsense' }));
    await expect(readLocalTimer()).resolves.toBeNull();
    store.set(LOCAL_TIMER_KEY, '{not json');
    await expect(readLocalTimer()).resolves.toBeNull();
  });

  it('stamps a stable per-launch monotonic epoch and distinct local ids', () => {
    const a = stampNow();
    const b = stampNow();
    expect(a.monoEpochId).toBe(currentMonoEpochId());
    expect(b.monoEpochId).toBe(a.monoEpochId);
    expect(a.localId).not.toBe(b.localId);
    expect(typeof a.wallMs).toBe('number');
  });
});
