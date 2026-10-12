import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  ARRIVAL_MEMORY_KEY,
  clearFarReads,
  readArrivalMemory,
  readFarReads,
  recordDismiss,
  recordFarRead,
  recordPick,
  recordStopAtSite,
} from './arrivalMemory';

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

beforeEach(() => {
  store.clear();
});

describe('arrivalMemory', () => {
  it('round-trips dismissals, last stops and last picks', async () => {
    await recordDismiss(['a', 'b'], NOW);
    await recordStopAtSite('a', NOW + 1000);
    await recordPick('a,b', 'b', NOW + 2000);
    expect(await readArrivalMemory(NOW + 3000)).toEqual({
      dismissedAt: { a: NOW, b: NOW },
      lastStopAt: { a: NOW + 1000 },
      lastPick: { 'a,b': 'b' },
    });
  });

  it('prunes entries older than 24 h on write', async () => {
    await recordDismiss(['old'], NOW - 25 * HOUR);
    await recordDismiss(['new'], NOW);
    const mem = await readArrivalMemory(NOW);
    expect(mem.dismissedAt).toEqual({ new: NOW });
  });

  it('corrupted JSON → empty memory, no throw', async () => {
    store.set(ARRIVAL_MEMORY_KEY, '{{{');
    expect(await readArrivalMemory(NOW)).toEqual({
      dismissedAt: {},
      lastStopAt: {},
      lastPick: {},
    });
    // and a write over the top of it still works
    await recordDismiss(['a'], NOW);
    expect((await readArrivalMemory(NOW)).dismissedAt).toEqual({ a: NOW });
  });

  it('keeps only well-typed fields from a hand-edited blob', async () => {
    store.set(
      ARRIVAL_MEMORY_KEY,
      JSON.stringify({ dismissedAt: { a: 'x', b: NOW }, lastPick: { k: 5 }, extra: 1 })
    );
    expect(await readArrivalMemory(NOW)).toEqual({
      dismissedAt: { b: NOW },
      lastStopAt: {},
      lastPick: {},
    });
  });
});

describe('far reads (still-at-site stop prompt)', () => {
  it('keeps the last 3 per entry, oldest first', async () => {
    for (let i = 1; i <= 4; i++) {
      await recordFarRead('e1', { atMs: NOW + i, distanceM: 100 * i });
    }
    expect(await readFarReads('e1')).toEqual([
      { atMs: NOW + 2, distanceM: 200 },
      { atMs: NOW + 3, distanceM: 300 },
      { atMs: NOW + 4, distanceM: 400 },
    ]);
  });

  it('is keyed by entry and clearFarReads removes only that entry', async () => {
    await recordFarRead('e1', { atMs: NOW, distanceM: 500 });
    await recordFarRead('e2', { atMs: NOW, distanceM: 600 });
    await clearFarReads('e1');
    expect(await readFarReads('e1')).toEqual([]);
    expect(await readFarReads('e2')).toHaveLength(1);
  });
});
