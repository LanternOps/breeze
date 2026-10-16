import { describe, expect, it } from 'vitest';

import type { LocationPermissionState } from '../../services/locationPermission';

import {
  EXPLAINER_COPY,
  EXPLAINER_REOFFER_MS,
  explainerVisible,
  locationRowCopy,
} from './locationSettingsLogic';

const ALL: LocationPermissionState[] = [
  'undetermined',
  'granted',
  'granted-approximate',
  'denied-can-ask',
  'denied-blocked',
  'services-off',
];

describe('locationRowCopy', () => {
  it('is hidden for every state when the partner feature is off', () => {
    for (const s of ALL) expect(locationRowCopy(s, false)).toEqual({ visible: false });
  });

  it('undetermined and denied-can-ask offer "Turn on" via the OS dialog', () => {
    for (const s of ['undetermined', 'denied-can-ask'] as const) {
      expect(locationRowCopy(s, true)).toMatchObject({
        visible: true,
        status: 'Turn on',
        action: 'request',
      });
    }
  });

  it('granted reads "On" and has no action', () => {
    expect(locationRowCopy('granted', true)).toMatchObject({
      visible: true,
      status: 'On',
      action: 'none',
    });
  });

  it('approximate location says suggestions need precise and opens Settings', () => {
    expect(locationRowCopy('granted-approximate', true)).toMatchObject({
      status: 'Precise location is off — suggestions need it',
      action: 'open-settings',
    });
  });

  it('blocked says location is off for Breeze and opens Settings', () => {
    expect(locationRowCopy('denied-blocked', true)).toMatchObject({
      status: 'Location is off for Breeze — open Settings',
      action: 'open-settings',
    });
  });

  it('services off opens Settings', () => {
    expect(locationRowCopy('services-off', true)).toMatchObject({ action: 'open-settings' });
  });

  it('no copy anywhere says "tracking"', () => {
    for (const s of ALL) {
      const copy = locationRowCopy(s, true);
      if (copy.visible) {
        expect(`${copy.status} ${copy.description}`.toLowerCase()).not.toContain('track');
      }
    }
    expect(EXPLAINER_COPY.body.toLowerCase()).not.toContain('track');
  });

  it('the explainer states that the position stays on the phone', () => {
    expect(EXPLAINER_COPY.body).toBe(
      "Breeze can suggest starting a timer when you arrive at a client site. Your location is checked on this phone only and never sent to Breeze."
    );
  });
});

describe('explainerVisible', () => {
  const NOW = 1_800_000_000_000;
  const base = { partnerEnabled: true, state: 'undetermined' as const, dismissedAtMs: null, nowMs: NOW };

  it('shows for partner on + undetermined + never dismissed', () => {
    expect(explainerVisible(base)).toBe(true);
  });

  it('hides when the partner feature is off', () => {
    expect(explainerVisible({ ...base, partnerEnabled: false })).toBe(false);
  });

  it('hides for every state other than undetermined', () => {
    for (const s of ALL.filter((x) => x !== 'undetermined')) {
      expect(explainerVisible({ ...base, state: s })).toBe(false);
    }
  });

  it('stays hidden for 30 days after "Not now", then re-offers', () => {
    expect(explainerVisible({ ...base, dismissedAtMs: NOW - (EXPLAINER_REOFFER_MS - 1000) })).toBe(false);
    expect(explainerVisible({ ...base, dismissedAtMs: NOW - (EXPLAINER_REOFFER_MS + 1000) })).toBe(true);
  });
});
