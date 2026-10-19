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

// iOS 27 refuses to launch an app linked against the iOS 27 SDK unless it
// adopts the UIScene life cycle (build 1.0.1 (84) was rejected for exactly
// this: EXC_BREAKPOINT in UIApplicationEvaluateRuntimeIssueForNoSceneLifecycle-
// Adoption on every review device, while iOS 26 TestFlight devices were fine).
// Expo wires the scene delegate in from expo-build-properties; this guards the
// flag against being dropped in a plugin reshuffle. See STORE_SUBMISSION.md.
describe('app.json iOS scene lifecycle (iOS 27 launch requirement)', () => {
  const entry = expo.plugins.find(
    (p: unknown) => Array.isArray(p) && p[0] === 'expo-build-properties'
  );

  it('enables scene support through expo-build-properties', () => {
    expect(entry).toBeDefined();
    expect(entry[1].ios.enableSceneSupport).toBe(true);
  });

  it('runs expo-build-properties before any plugin that could edit AppDelegate', () => {
    // The plugin refuses a non-template AppDelegate.swift, so it must see the
    // file before anything else touches it.
    expect(expo.plugins[0]).toBe(entry);
  });
});
