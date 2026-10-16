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

describe('location provenance round-trip (#8211)', () => {
  it('persists orgId / siteId / source and reads them back', async () => {
    await writeLocalTimer({ ...timer, orgId: 'o1', siteId: 's1', source: 'location' });
    expect(await readLocalTimer()).toMatchObject({ orgId: 'o1', siteId: 's1', source: 'location' });
  });

  it('a legacy record reads back without the keys', async () => {
    await writeLocalTimer(timer);
    expect(await readLocalTimer()).not.toHaveProperty('siteId');
  });

  it('drops a source other than timer|location', async () => {
    store.set(
      LOCAL_TIMER_KEY,
      JSON.stringify({ ...timer, orgId: 'o1', siteId: 's1', source: 'remote_session' })
    );
    expect(await readLocalTimer()).not.toHaveProperty('source');
  });
});

describe('localTimer', () => {
  it('round-trips a timer through storage', async () => {
    await writeLocalTimer(timer);
    await expect(readLocalTimer()).resolves.toEqual(timer);
    await clearLocalTimer();
    await expect(readLocalTimer()).resolves.toBeNull();
  });

  it('round-trips a chosen work type, including an explicit null (#4628 W04)', async () => {
    await writeLocalTimer({ ...timer, workTypeId: 'wt-2' });
    await expect(readLocalTimer()).resolves.toEqual({ ...timer, workTypeId: 'wt-2' });
    await writeLocalTimer({ ...timer, workTypeId: null });
    await expect(readLocalTimer()).resolves.toEqual({ ...timer, workTypeId: null });
  });

  it('a timer persisted by an older build (no workTypeId) reads back WITHOUT the field', async () => {
    await writeLocalTimer(timer);
    expect(await readLocalTimer()).not.toHaveProperty('workTypeId');
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
