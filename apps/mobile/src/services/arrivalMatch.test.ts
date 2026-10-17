import { describe, expect, it } from 'vitest';

import {
  DISMISS_SUPPRESS_MS,
  READ_DEBOUNCE_MS,
  RECENT_STOP_SUPPRESS_MS,
  decideArrival,
  decideStillHere,
  groupKey,
  matchCandidates,
  shouldReadPosition,
  type CachedSite,
  type Fix,
} from './arrivalMatch';

const NOW = 1_800_000_000_000;
// ~111.2 m per 0.001° of latitude.
const M = 1 / 111_195;

function site(id: string, metersNorth: number, over: Partial<CachedSite> = {}): CachedSite {
  return {
    id,
    orgId: `org-${id}`,
    orgName: `Org ${id}`,
    name: `Site ${id}`,
    latitude: metersNorth * M,
    longitude: 0,
    geofenceRadiusM: null,
    ...over,
  };
}

const fix = (accuracyM: number | null = 20): Fix => ({
  latitude: 0,
  longitude: 0,
  accuracyM,
  atMs: NOW,
});

const base = {
  enabled: true,
  timerRunning: false,
  fix: fix(),
  sites: [site('a', 40)],
  defaultRadiusM: 150,
  dismissedAt: {},
  lastStopAt: {},
  lastPick: {},
  nowMs: NOW,
};

describe('matchCandidates', () => {
  it('drops sites without coordinates', () => {
    const out = matchCandidates(
      fix(),
      [site('a', 10, { latitude: null, longitude: null }), site('b', 10)],
      150
    );
    expect(out.map((c) => c.siteId)).toEqual(['b']);
  });

  it('uses the site radius, else the partner default', () => {
    const sites = [site('a', 120, { geofenceRadiusM: 100 }), site('b', 120)];
    expect(matchCandidates(fix(), sites, 150).map((c) => c.siteId)).toEqual(['b']);
  });

  it('widens to the fix accuracy: radius 100, accuracy 300, site 250 m away → match', () => {
    const sites = [site('a', 250, { geofenceRadiusM: 100 })];
    expect(matchCandidates(fix(300), sites, 150)).toHaveLength(1);
    expect(matchCandidates(fix(20), sites, 150)).toHaveLength(0);
  });

  it('sorts by distance, ties by site name', () => {
    const out = matchCandidates(
      fix(),
      [site('c', 80), site('b', 20, { name: 'Zed' }), site('a', 20, { name: 'Alpha' })],
      150
    );
    expect(out.map((c) => c.siteId)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toMatchObject({
      orgId: 'org-a',
      orgName: 'Org a',
      siteName: 'Alpha',
    });
  });
});

describe('decideArrival', () => {
  it('flag off → none/flag-off (checked first)', () => {
    expect(decideArrival({ ...base, enabled: false, timerRunning: true })).toEqual({
      kind: 'none',
      reason: 'flag-off',
    });
  });

  it('timer running → none/timer-running even with candidates', () => {
    expect(decideArrival({ ...base, timerRunning: true })).toEqual({
      kind: 'none',
      reason: 'timer-running',
    });
  });

  it('accuracy 500 → evaluated; 501 → poor-accuracy; null → poor-accuracy', () => {
    expect(decideArrival({ ...base, fix: fix(500), sites: [site('a', 40)] }).kind).toBe('prompt');
    expect(decideArrival({ ...base, fix: fix(501) })).toEqual({
      kind: 'none',
      reason: 'poor-accuracy',
    });
    expect(decideArrival({ ...base, fix: fix(null) })).toEqual({
      kind: 'none',
      reason: 'poor-accuracy',
    });
  });

  it('no candidates in range → none/no-candidates', () => {
    expect(decideArrival({ ...base, sites: [site('a', 5000)] })).toEqual({
      kind: 'none',
      reason: 'no-candidates',
    });
  });

  it('accuracy 450 with two sites inside 450 m → picker with both, never a single-site prompt', () => {
    const d = decideArrival({
      ...base,
      fix: fix(450),
      sites: [site('a', 300), site('b', 400)],
    });
    expect(d.kind).toBe('prompt');
    if (d.kind === 'prompt') {
      expect(d.candidates.map((c) => c.siteId)).toEqual(['a', 'b']);
    }
  });

  it('one candidate → prompt with that one', () => {
    const d = decideArrival(base);
    expect(d.kind).toBe('prompt');
    if (d.kind === 'prompt') expect(d.candidates.map((c) => c.siteId)).toEqual(['a']);
  });

  it('two candidates 5 m apart → prompt with both, never auto-picked', () => {
    const d = decideArrival({ ...base, sites: [site('a', 40), site('b', 45)] });
    expect(d.kind).toBe('prompt');
    if (d.kind === 'prompt') {
      expect(d.candidates).toHaveLength(2);
      expect(d.preselectSiteId).toBeNull();
    }
  });

  it('dismissed 3h59m ago → suppressed; 4h01m → shown', () => {
    const dismissed = (agoMs: number) => ({ a: NOW - agoMs });
    expect(decideArrival({ ...base, dismissedAt: dismissed(DISMISS_SUPPRESS_MS - 60_000) })).toEqual({
      kind: 'none',
      reason: 'all-suppressed',
    });
    expect(decideArrival({ ...base, dismissedAt: dismissed(DISMISS_SUPPRESS_MS + 60_000) }).kind).toBe(
      'prompt'
    );
  });

  it('stopped at this site 29 min ago → suppressed; the other candidate is still shown', () => {
    const lastStopAt = { a: NOW - (RECENT_STOP_SUPPRESS_MS - 60_000) };
    expect(decideArrival({ ...base, lastStopAt })).toEqual({
      kind: 'none',
      reason: 'all-suppressed',
    });
    const d = decideArrival({ ...base, sites: [site('a', 40), site('b', 60)], lastStopAt });
    expect(d.kind).toBe('prompt');
    if (d.kind === 'prompt') expect(d.candidates.map((c) => c.siteId)).toEqual(['b']);
    // 31 min ago is no longer suppressed
    expect(
      decideArrival({ ...base, lastStopAt: { a: NOW - (RECENT_STOP_SUPPRESS_MS + 60_000) } }).kind
    ).toBe('prompt');
  });

  it('lastPick for the candidate group → preselectSiteId', () => {
    const sites = [site('a', 40), site('b', 60)];
    const key = groupKey(['b', 'a']);
    const d = decideArrival({ ...base, sites, lastPick: { [key]: 'b' } });
    expect(d.kind === 'prompt' && d.preselectSiteId).toBe('b');
  });

  it('a stale lastPick that is no longer a candidate is ignored', () => {
    const d = decideArrival({ ...base, lastPick: { [groupKey(['a'])]: 'zzz' } });
    expect(d.kind === 'prompt' && d.preselectSiteId).toBeNull();
  });
});

describe('groupKey', () => {
  it('is order-independent', () => {
    expect(groupKey(['b', 'a'])).toBe('a,b');
  });
});

describe('shouldReadPosition', () => {
  it('first read → true; 4m59s later → false; manual refresh → true; 5m → true', () => {
    expect(shouldReadPosition(null, NOW, false)).toBe(true);
    expect(shouldReadPosition(NOW - (READ_DEBOUNCE_MS - 1000), NOW, false)).toBe(false);
    expect(shouldReadPosition(NOW - 1000, NOW, true)).toBe(true);
    expect(shouldReadPosition(NOW - READ_DEBOUNCE_MS, NOW, false)).toBe(true);
  });
});

describe('decideStillHere', () => {
  const s = site('a', 0);
  const running = { source: 'location', siteId: 'a' };
  const far = (atMs: number, distanceM = 400) => ({ atMs, distanceM });
  const input = (over: object = {}) => ({
    running,
    site: s,
    defaultRadiusM: 150,
    farReads: [far(NOW - 6 * 60_000), far(NOW)],
    ...over,
  });

  it('only for source=location timers with a site', () => {
    expect(decideStillHere(input({ running: { source: 'timer', siteId: 'a' } }))).toEqual({
      kind: 'none',
    });
    expect(decideStillHere(input({ running: { source: 'location', siteId: null } }))).toEqual({
      kind: 'none',
    });
    expect(decideStillHere(input({ running: null }))).toEqual({ kind: 'none' });
    expect(decideStillHere(input({ site: null }))).toEqual({ kind: 'none' });
    expect(decideStillHere(input())).toEqual({ kind: 'prompt', siteId: 'a' });
  });

  it('one far read → none; two far reads 4 min apart → none; 5 min apart → prompt', () => {
    expect(decideStillHere(input({ farReads: [far(NOW)] }))).toEqual({ kind: 'none' });
    expect(decideStillHere(input({ farReads: [far(NOW - 4 * 60_000), far(NOW)] }))).toEqual({
      kind: 'none',
    });
    expect(
      decideStillHere(input({ farReads: [far(NOW - READ_DEBOUNCE_MS), far(NOW)] })).kind
    ).toBe('prompt');
  });

  it('far = > 2× (site radius ?? default)', () => {
    // default 150 → far means > 300
    expect(
      decideStillHere(input({ farReads: [far(NOW - 6 * 60_000, 300), far(NOW, 300)] }))
    ).toEqual({ kind: 'none' });
    // site radius 100 → far means > 200
    expect(
      decideStillHere(
        input({
          site: site('a', 0, { geofenceRadiusM: 100 }),
          farReads: [far(NOW - 6 * 60_000, 250), far(NOW, 250)],
        })
      ).kind
    ).toBe('prompt');
  });
});
