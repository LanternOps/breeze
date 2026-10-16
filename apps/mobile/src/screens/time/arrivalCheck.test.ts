import { describe, expect, it, vi } from 'vitest';

import type { CachedSite, Fix } from '../../services/arrivalMatch';
import type { LocationSitesSnapshot } from '../../services/locationSites';
import { createPrecisionTracker } from '../../services/locationPermission';

import { runArrivalCheck, type ArrivalCheckDeps } from './arrivalCheck';

const NOW = 1_800_000_000_000;
const M = 1 / 111_195;

const site = (id: string, metersNorth: number): CachedSite => ({
  id,
  orgId: `org-${id}`,
  orgName: `Org ${id}`,
  name: `Site ${id}`,
  latitude: metersNorth * M,
  longitude: 0,
  geofenceRadiusM: null,
});

const snapshot = (over: Partial<LocationSitesSnapshot> = {}): LocationSitesSnapshot => ({
  enabled: true,
  defaultRadiusM: 150,
  canSetLocation: false,
  sites: [site('a', 40)],
  fetchedAtMs: NOW,
  ...over,
});

const fixAt = (accuracyM: number | null = 20): Fix => ({
  latitude: 0,
  longitude: 0,
  accuracyM,
  atMs: NOW,
});

function deps(over: Partial<ArrivalCheckDeps> = {}): ArrivalCheckDeps {
  const farReads: Record<string, Array<{ atMs: number; distanceM: number }>> = {};
  let lastRead: number | null = null;
  return {
    nowMs: () => NOW,
    getSnapshot: vi.fn().mockResolvedValue(snapshot()),
    running: () => null,
    localTimerRunning: vi.fn().mockResolvedValue(false),
    getPermission: vi.fn().mockResolvedValue({
      perm: { status: 'granted', canAskAgain: true },
      servicesEnabled: true,
    }),
    readFix: vi.fn().mockResolvedValue(fixAt()),
    readMemory: vi.fn().mockResolvedValue({ dismissedAt: {}, lastStopAt: {}, lastPick: {} }),
    readFarReads: vi.fn(async (k: string) => farReads[k] ?? []),
    recordFarRead: vi.fn(async (k: string, r) => {
      farReads[k] = [...(farReads[k] ?? []), r].slice(-3);
    }),
    clearFarReads: vi.fn(async (k: string) => {
      delete farReads[k];
    }),
    getLastReadMs: () => lastRead,
    setLastReadMs: (ms: number) => {
      lastRead = ms;
    },
    precision: createPrecisionTracker(),
    ...over,
  };
}

describe('runArrivalCheck — arrival', () => {
  it('prompts with the candidate when everything lines up', async () => {
    const out = await runArrivalCheck(deps(), { manual: false });
    expect(out).toMatchObject({ kind: 'arrival', preselectSiteId: null });
    if (out.kind === 'arrival') expect(out.candidates.map((c) => c.siteId)).toEqual(['a']);
  });

  it('flag off: no permission lookup, no position read', async () => {
    const d = deps({ getSnapshot: vi.fn().mockResolvedValue(snapshot({ enabled: false })) });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({ kind: 'none', reason: 'flag-off' });
    expect(d.getPermission).not.toHaveBeenCalled();
    expect(d.readFix).not.toHaveBeenCalled();
  });

  it('no snapshot (offline, no cache / access lost) → none', async () => {
    const d = deps({ getSnapshot: vi.fn().mockResolvedValue(null) });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({ kind: 'none', reason: 'flag-off' });
  });

  it('a running redux timer that is not a location timer → none, no read', async () => {
    const d = deps({ running: () => ({ id: 'e1', localId: null, source: 'timer', siteId: null, startedAt: '2026-01-01T00:00:00Z' }) });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({
      kind: 'none',
      reason: 'timer-running',
    });
    expect(d.getPermission).not.toHaveBeenCalled();
    expect(d.readFix).not.toHaveBeenCalled();
  });

  it('a device-only local timer also suppresses', async () => {
    const d = deps({ localTimerRunning: vi.fn().mockResolvedValue(true) });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({
      kind: 'none',
      reason: 'timer-running',
    });
    expect(d.readFix).not.toHaveBeenCalled();
  });

  it.each([
    ['undetermined', { status: 'undetermined', canAskAgain: true }, true],
    ['denied', { status: 'denied', canAskAgain: false }, true],
    ['android coarse', { status: 'granted', canAskAgain: true, android: { accuracy: 'coarse' } }, true],
    ['services off', { status: 'granted', canAskAgain: true }, false],
  ] as const)('permission %s → no read, never asks', async (_n, perm, servicesEnabled) => {
    const d = deps({ getPermission: vi.fn().mockResolvedValue({ perm, servicesEnabled }) });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({
      kind: 'none',
      reason: 'permission',
    });
    expect(d.readFix).not.toHaveBeenCalled();
  });

  it('debounces reads to one per 5 minutes; a manual refresh bypasses it', async () => {
    const d = deps();
    await runArrivalCheck(d, { manual: false });
    expect(d.readFix).toHaveBeenCalledTimes(1);
    expect(await runArrivalCheck(d, { manual: false })).toEqual({ kind: 'none', reason: 'debounced' });
    expect(d.readFix).toHaveBeenCalledTimes(1);
    await runArrivalCheck(d, { manual: true });
    expect(d.readFix).toHaveBeenCalledTimes(2);
  });

  it('no fix available → none', async () => {
    const d = deps({ readFix: vi.fn().mockResolvedValue(null) });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({ kind: 'none', reason: 'no-fix' });
  });

  it('a poor-accuracy fix is passed through as decideArrival\'s own reason, and noted by the tracker', async () => {
    const precision = createPrecisionTracker();
    const d = deps({ readFix: vi.fn().mockResolvedValue(fixAt(900)), precision });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({
      kind: 'none',
      reason: 'poor-accuracy',
    });
    await runArrivalCheck(d, { manual: true });
    expect(precision.observedReducedPrecision()).toBe(true);
  });
});

describe('runArrivalCheck — still-here stop prompt', () => {
  const running = (over: object = {}) => ({
    id: 'e1',
    localId: null,
    source: 'location',
    siteId: 'a',
    startedAt: new Date(NOW - 148 * 60_000).toISOString(),
    ...over,
  });
  // site `a` is 5 km away from the fix at (0,0) → far
  const farSnapshot = snapshot({ sites: [site('a', 5000)] });

  it('first far read records it and does not prompt; a second 5+ min later prompts', async () => {
    let now = NOW;
    const d = deps({
      nowMs: () => now,
      readFix: vi.fn(async () => ({ ...fixAt(), atMs: now })),
      running: () => running(),
      getSnapshot: vi.fn().mockResolvedValue(farSnapshot),
    });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({ kind: 'none', reason: 'still-there' });
    now += 6 * 60_000;
    const out = await runArrivalCheck(d, { manual: false });
    expect(out).toMatchObject({ kind: 'stop', siteId: 'a', placeName: 'Org a', runningMinutes: 154 });
  });

  it('a near read clears the far reads so a brief trip does not prompt', async () => {
    let now = NOW;
    const near = snapshot({ sites: [site('a', 20)] });
    const d = deps({
      nowMs: () => now,
      running: () => running(),
      getSnapshot: vi.fn().mockResolvedValue(near),
    });
    await runArrivalCheck(d, { manual: false });
    expect(d.clearFarReads).toHaveBeenCalledWith('e1');
    expect(d.recordFarRead).not.toHaveBeenCalled();
  });

  it('never prompts for a non-location timer, and never reads for one', async () => {
    const d = deps({ running: () => running({ source: 'timer', siteId: null }) });
    await runArrivalCheck(d, { manual: false });
    expect(d.readFix).not.toHaveBeenCalled();
  });

  it('keys far reads by the local id for a device-only timer', async () => {
    const d = deps({
      running: () => running({ id: null, localId: 'l1' }),
      getSnapshot: vi.fn().mockResolvedValue(farSnapshot),
    });
    await runArrivalCheck(d, { manual: false });
    expect(d.recordFarRead).toHaveBeenCalledWith('l1', expect.objectContaining({ atMs: NOW }));
  });

  it('a site that dropped out of the cached list → none, no read', async () => {
    const d = deps({
      running: () => running(),
      getSnapshot: vi.fn().mockResolvedValue(snapshot({ sites: [] })),
    });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({
      kind: 'none',
      reason: 'timer-running',
    });
    expect(d.readFix).not.toHaveBeenCalled();
  });

  it('does not run when the partner flag is off', async () => {
    const d = deps({
      running: () => running(),
      getSnapshot: vi.fn().mockResolvedValue({ ...farSnapshot, enabled: false }),
    });
    expect(await runArrivalCheck(d, { manual: false })).toEqual({ kind: 'none', reason: 'flag-off' });
    expect(d.readFix).not.toHaveBeenCalled();
  });
});
