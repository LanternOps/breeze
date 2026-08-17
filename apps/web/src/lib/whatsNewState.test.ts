import { describe, it, expect } from 'vitest';
import { decideWhatsNew, markSeen, latestApplicableEntry, LAST_SEEN_KEY } from './whatsNewState';
import type { WhatsNewEntry } from './whatsNew';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

const ENTRIES: WhatsNewEntry[] = [
  { version: '0.105.0', date: '2026-08-12', title: 'B', highlights: ['b'] },
  { version: '0.104.0', date: '2026-08-08', title: 'A', highlights: ['a'] },
];

describe('decideWhatsNew', () => {
  it('never shows on dev builds', () => {
    const s = fakeStorage();
    expect(decideWhatsNew(s, 'dev', ENTRIES)).toEqual({ entry: null, baselineToSet: null });
    expect(s._map.has(LAST_SEEN_KEY)).toBe(false);
  });

  // #3646: an existing user upgrading from a build that predates the feature has
  // no floor either, so "no floor" must not baseline the current entry away.
  it('shows the newest shipped entry when there is no floor', () => {
    const s = fakeStorage();
    const d = decideWhatsNew(s, '0.105.0', ENTRIES);
    expect(d.entry?.version).toBe('0.105.0');
    expect(d.baselineToSet).toBeNull();
    expect(s._map.has(LAST_SEEN_KEY)).toBe(false);
  });

  it('shows at most one entry with no floor, even with a backlog', () => {
    const s = fakeStorage();
    expect(decideWhatsNew(s, '0.105.0', ENTRIES).entry?.version).toBe('0.105.0');
  });

  it('no floor still respects the running web version', () => {
    const s = fakeStorage();
    expect(decideWhatsNew(s, '0.104.0', ENTRIES).entry?.version).toBe('0.104.0');
  });

  it('no floor and nothing applicable sets the baseline instead', () => {
    const s = fakeStorage();
    expect(decideWhatsNew(s, '0.103.0', ENTRIES)).toEqual({
      entry: null,
      baselineToSet: '0.103.0',
    });
  });

  it('treats an empty stored floor as absent', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '' });
    expect(decideWhatsNew(s, '0.105.0', ENTRIES).entry?.version).toBe('0.105.0');
  });

  it('does not re-show after the no-floor entry is acknowledged', () => {
    const s = fakeStorage();
    const first = decideWhatsNew(s, '0.105.0', ENTRIES);
    markSeen(s, first.entry!.version);
    expect(decideWhatsNew(s, '0.105.0', ENTRIES).entry).toBeNull();
  });

  it('shows the newest entry above the floor and at/below web version', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.104.0' });
    const d = decideWhatsNew(s, '0.105.0', ENTRIES);
    expect(d.entry?.version).toBe('0.105.0');
    expect(d.baselineToSet).toBeNull();
  });

  it('shows nothing when floor equals newest', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.105.0' });
    expect(decideWhatsNew(s, '0.105.0', ENTRIES).entry).toBeNull();
  });

  it('suppresses entries newer than the running web version', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.103.0' });
    // web is 0.104.0, so 0.105.0 must not show; 0.104.0 should.
    expect(decideWhatsNew(s, '0.104.0', ENTRIES).entry?.version).toBe('0.104.0');
  });

  it('shows nothing after markSeen', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.104.0' });
    markSeen(s, '0.105.0');
    expect(decideWhatsNew(s, '0.105.0', ENTRIES).entry).toBeNull();
  });
});

describe('latestApplicableEntry', () => {
  it('returns newest entry <= web version regardless of floor', () => {
    expect(latestApplicableEntry('0.104.0', ENTRIES)?.version).toBe('0.104.0');
  });
  it('returns newest entry on dev (for demoability)', () => {
    expect(latestApplicableEntry('dev', ENTRIES)?.version).toBe('0.105.0');
  });
});
