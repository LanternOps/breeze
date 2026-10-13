import { describe, expect, it } from 'vitest';

import { canStartFromArrival, entryKeyOf, stopTargetMatches } from './arrivalGuards';

describe('canStartFromArrival', () => {
  it('only when neither the store nor the device has a timer', () => {
    expect(canStartFromArrival({ storeRunning: false, localTimer: 'none' })).toBe(true);
    expect(canStartFromArrival({ storeRunning: true, localTimer: 'none' })).toBe(false);
    expect(canStartFromArrival({ storeRunning: false, localTimer: 'present' })).toBe(false);
    expect(canStartFromArrival({ storeRunning: true, localTimer: 'present' })).toBe(false);
  });

  it('fails closed when the local timer could not be read', () => {
    expect(canStartFromArrival({ storeRunning: false, localTimer: 'unreadable' })).toBe(false);
  });
});

describe('stopTargetMatches', () => {
  const run = (over: object = {}) => ({ id: 'e1', localId: null, source: 'location', siteId: 's1', ...over });

  it('is true only for the location timer at the site the sheet was about', () => {
    expect(stopTargetMatches(run(), 's1')).toBe(true);
    expect(stopTargetMatches(run({ siteId: 's2' }), 's1')).toBe(false);
    expect(stopTargetMatches(run({ source: 'timer' }), 's1')).toBe(false);
    expect(stopTargetMatches(null, 's1')).toBe(false);
  });
});

describe('entryKeyOf', () => {
  it('prefers the server id, then the local id', () => {
    expect(entryKeyOf({ id: 'e1', localId: 'l1' })).toBe('e1');
    expect(entryKeyOf({ id: null, localId: 'l1' })).toBe('l1');
    expect(entryKeyOf({ id: null, localId: null })).toBeNull();
    expect(entryKeyOf(null)).toBeNull();
  });
});
