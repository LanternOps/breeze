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

  it('registers expo-build-properties LAST so its AppDelegate edit runs FIRST', () => {
    // Expo config-plugin mods run in reverse registration order ("plugins
    // order matter: the later one would run first" — expo-build-properties
    // source). The scene plugin refuses a non-template AppDelegate.swift, so
    // it has to see the file before any other plugin touches it, which means
    // it must be the LAST entry here.
    expect(expo.plugins[expo.plugins.length - 1]).toBe(entry);
  });
});

// The expo-modules-jsi pnpm patch (patches/expo-modules-jsi@<ver>.patch) is
// keyed to an exact transitive version and the root `allowUnusedPatches: true`
// turns a version drift into a warning buried in install output. Without this
// guard a routine bump moves the package, the patch silently stops applying,
// CI on Xcode 26 stays green, and the next Xcode 27.1 Archive dies again with
// "cannot find type '__ObjC::expo' in scope". Delete this block together with
// the patch once expo-modules-jsi ships upstream expo/expo#50569.
describe('expo-modules-jsi Swift 6.4 patch stays attached to the resolved version', () => {
  const lock = readFileSync(join(__dirname, '../../../../pnpm-lock.yaml'), 'utf8');
  const rootPkg = JSON.parse(readFileSync(join(__dirname, '../../../../package.json'), 'utf8'));
  const patched: Record<string, string> = rootPkg.pnpm?.patchedDependencies ?? {};
  const resolved = [...new Set([...lock.matchAll(/^  expo-modules-jsi@([^:(]+)/gm)].map((m) => m[1]))];

  it('resolves at least one expo-modules-jsi version', () => {
    expect(resolved.length).toBeGreaterThan(0);
  });

  it.each(resolved)('has a pnpm patch entry for expo-modules-jsi@%s', (version) => {
    expect(patched[`expo-modules-jsi@${version}`]).toMatch(/^patches\/expo-modules-jsi@/);
  });
});
