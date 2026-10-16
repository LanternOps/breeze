import { describe, expect, it } from 'vitest';

import type { CachedSite, Fix } from '../../services/arrivalMatch';
import type { LocationSitesSnapshot } from '../../services/locationSites';

import {
  PIN_MAX_ACCURACY_M,
  pinButtonLabel,
  pinFailureMessage,
  pinPreflight,
  pinTargets,
} from './sitePinLogic';

const site = (id: string, orgId: string, withCoords: boolean): CachedSite => ({
  id,
  orgId,
  orgName: `Org ${orgId}`,
  name: `Site ${id}`,
  latitude: withCoords ? 40 : null,
  longitude: withCoords ? -74 : null,
  geofenceRadiusM: null,
});

const snapshot = (over: Partial<LocationSitesSnapshot> = {}): LocationSitesSnapshot => ({
  enabled: true,
  defaultRadiusM: 150,
  canSetLocation: true,
  sites: [site('a', 'o1', false), site('b', 'o1', true), site('c', 'o2', false)],
  fetchedAtMs: 0,
  ...over,
});

describe('pinTargets', () => {
  it('lists the org\'s sites that have no coordinates yet', () => {
    expect(pinTargets(snapshot(), 'o1').map((s) => s.id)).toEqual(['a']);
  });

  it('lists every unpinned site of the org so the UI can offer a picker', () => {
    const s = snapshot({ sites: [site('a', 'o1', false), site('b', 'o1', false)] });
    expect(pinTargets(s, 'o1').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('is empty when the user may not set locations', () => {
    expect(pinTargets(snapshot({ canSetLocation: false }), 'o1')).toEqual([]);
  });

  it('is empty when the partner feature is off', () => {
    expect(pinTargets(snapshot({ enabled: false }), 'o1')).toEqual([]);
  });

  it('is empty without a snapshot or an org', () => {
    expect(pinTargets(null, 'o1')).toEqual([]);
    expect(pinTargets(snapshot(), null)).toEqual([]);
  });

  it('is empty when the org has no unpinned sites', () => {
    expect(pinTargets(snapshot(), 'o3')).toEqual([]);
    expect(pinTargets(snapshot({ sites: [site('b', 'o1', true)] }), 'o1')).toEqual([]);
  });
});

describe('pinPreflight', () => {
  const fix = (accuracyM: number | null): Fix => ({
    latitude: 1,
    longitude: 2,
    accuracyM,
    atMs: 0,
  });

  it('accepts 100 m, rejects 101 m and a missing accuracy or fix', () => {
    expect(PIN_MAX_ACCURACY_M).toBe(100);
    expect(pinPreflight(fix(100))).toEqual({ ok: true });
    const tooCoarse = {
      ok: false,
      message: "Location isn't precise enough here. Step outside or near a window and try again.",
    };
    expect(pinPreflight(fix(101))).toEqual(tooCoarse);
    expect(pinPreflight(fix(null))).toEqual(tooCoarse);
    expect(pinPreflight(null)).toEqual(tooCoarse);
  });
});

describe('pinButtonLabel', () => {
  it('names the site', () => {
    expect(pinButtonLabel(site('a', 'o1', false))).toBe('Save my current location as Site a');
  });
});

describe('pinFailureMessage', () => {
  it('403 → permission copy, flagged to drop the cached list', () => {
    expect(pinFailureMessage({ statusCode: 403 })).toEqual({
      message: "You don't have permission to set site locations.",
      invalidate: true,
    });
  });

  it('404 → site gone, drop the cached list', () => {
    expect(pinFailureMessage({ statusCode: 404 })).toMatchObject({ invalidate: true });
  });

  it('anything else → generic copy, keep the cache', () => {
    expect(pinFailureMessage(new Error('boom'))).toEqual({
      message: "Couldn't save the location. Try again.",
      invalidate: false,
    });
  });

  it('never says "tracking"', () => {
    for (const e of [{ statusCode: 403 }, { statusCode: 404 }, new Error('x')]) {
      expect(pinFailureMessage(e).message.toLowerCase()).not.toContain('track');
    }
  });
});
