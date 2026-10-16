import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(__dirname, '../../app.json'), 'utf8');
const expo = JSON.parse(raw).expo;

describe('app.json location config (foreground only)', () => {
  it('declares the when-in-use usage description and never says "tracking"', () => {
    const copy = expo.ios.infoPlist.NSLocationWhenInUseUsageDescription as string;
    expect(copy).toMatch(/not sent to Breeze unless you choose/);
    expect(copy.toLowerCase()).not.toContain('track');
  });

  it('declares android coarse + fine location permissions', () => {
    expect(expo.android.permissions).toEqual(
      expect.arrayContaining(['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION'])
    );
  });

  it('configures the expo-location plugin with background modes off', () => {
    const entry = expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-location');
    expect(entry).toBeDefined();
    expect(entry[1].isIosBackgroundLocationEnabled).toBe(false);
    expect(entry[1].isAndroidBackgroundLocationEnabled).toBe(false);
    expect(entry[1].locationWhenInUsePermission).toBe(
      expo.ios.infoPlist.NSLocationWhenInUseUsageDescription
    );
  });

  it('does not leak W3 background location', () => {
    expect(raw).not.toMatch(/NSLocationAlways/);
    expect(raw).not.toMatch(/ACCESS_BACKGROUND_LOCATION/);
    const modes: string[] = expo.ios.infoPlist.UIBackgroundModes ?? [];
    expect(modes).not.toContain('location');
  });
});
