import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RING_FEATURE_UPDATES,
  featureUpdateAllowed,
  isWindowsFeatureUpdateCandidate,
  parseWindowsFeatureUpdateTitle,
  ringFeatureUpdatesSchema,
} from './ringFeatureUpdates';

describe('ringFeatureUpdatesSchema', () => {
  it('accepts block, allow and a well-formed pin', () => {
    expect(ringFeatureUpdatesSchema.parse({ mode: 'block' })).toEqual({ mode: 'block' });
    expect(ringFeatureUpdatesSchema.parse({ mode: 'allow' })).toEqual({ mode: 'allow' });
    expect(ringFeatureUpdatesSchema.parse({ mode: 'pin', product: 'windows-11', targetVersion: '25H2' }))
      .toEqual({ mode: 'pin', product: 'windows-11', targetVersion: '25H2' });
  });

  it('upper-cases the pinned release', () => {
    expect(ringFeatureUpdatesSchema.parse({ mode: 'pin', product: 'windows-10', targetVersion: '22h2' }))
      .toEqual({ mode: 'pin', product: 'windows-10', targetVersion: '22H2' });
  });

  it('rejects a pin without a release, an unknown mode, an unknown product and a malformed release', () => {
    expect(ringFeatureUpdatesSchema.safeParse({ mode: 'pin', product: 'windows-11' }).success).toBe(false);
    expect(ringFeatureUpdatesSchema.safeParse({ mode: 'pin', targetVersion: '25H2' }).success).toBe(false);
    expect(ringFeatureUpdatesSchema.safeParse({ mode: 'latest' }).success).toBe(false);
    expect(ringFeatureUpdatesSchema.safeParse({ mode: 'pin', product: 'windows-7', targetVersion: '25H2' }).success).toBe(false);
    expect(ringFeatureUpdatesSchema.safeParse({ mode: 'pin', product: 'windows-11', targetVersion: '25H3' }).success).toBe(false);
    expect(ringFeatureUpdatesSchema.safeParse({ mode: 'pin', product: 'windows-11', targetVersion: '2025' }).success).toBe(false);
  });

  it('defaults to block', () => {
    expect(DEFAULT_RING_FEATURE_UPDATES).toEqual({ mode: 'block' });
  });
});

describe('parseWindowsFeatureUpdateTitle', () => {
  // Vectors are identical to the agent's TestParseWindowsFeatureUpdateTitle.
  it.each([
    ['Windows 11, version 24H2', { product: 'windows-11', version: '24H2' }],
    ['Feature update to Windows 10, version 22H2 via Enablement Package (KB5015684)', { product: 'windows-10', version: '22H2' }],
    ['Windows 11, version 25h2', { product: 'windows-11', version: '25H2' }],
    ['Upgrade to Windows 11 Pro, version 24H2', { product: 'windows-11', version: '24H2' }],
    ['Feature Update to Windows 11 Version 23H2 via Enablement Package', { product: 'windows-11', version: '23H2' }],
    ['.NET Framework 4.8.1 for Windows 11, version 24H2 for x64 (KB5050187)', null],
    ['Microsoft .NET Framework 4.8.1 for Windows 11, version 21H2 for x64', null],
    ['2026-10 Cumulative Update Preview for .NET Framework 3.5 and 4.8.1 for Windows 11, version 24H2 for x64 (KB5064401)', null],
    ['2026-10 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5066835)', null],
    ['Microsoft .NET Framework 4.8.1 Feature Pack', null],
    ['', null],
  ])('%s', (title, expected) => {
    expect(parseWindowsFeatureUpdateTitle(title)).toEqual(expected);
  });
});

describe('isWindowsFeatureUpdateCandidate', () => {
  it('needs the microsoft source, the feature category and a release title', () => {
    expect(isWindowsFeatureUpdateCandidate({ source: 'microsoft', category: 'feature', title: 'Windows 11, version 25H2' })).toBe(true);
    expect(isWindowsFeatureUpdateCandidate({ source: 'microsoft', category: 'security', title: 'Windows 11, version 25H2' })).toBe(false);
    expect(isWindowsFeatureUpdateCandidate({ source: 'third_party', category: 'feature', title: 'Windows 11, version 25H2' })).toBe(false);
    expect(isWindowsFeatureUpdateCandidate({ source: 'microsoft', category: 'feature', title: 'Microsoft .NET Framework 4.8.1 Feature Pack' })).toBe(false);
    expect(isWindowsFeatureUpdateCandidate({ source: 'microsoft', category: null, title: 'Windows 11, version 25H2' })).toBe(false);
  });
});

describe('featureUpdateAllowed', () => {
  const pin = { mode: 'pin', product: 'windows-11', targetVersion: '25H2' } as const;
  it('block denies, allow permits', () => {
    expect(featureUpdateAllowed({ mode: 'block' }, 'Windows 11, version 25H2')).toBe(false);
    expect(featureUpdateAllowed({ mode: 'allow' }, 'Windows 11, version 26H2')).toBe(true);
  });
  it('pin permits only the exact product + release', () => {
    expect(featureUpdateAllowed(pin, 'Windows 11, version 25H2')).toBe(true);
    expect(featureUpdateAllowed(pin, 'Windows 11, version 25h2')).toBe(true);
    expect(featureUpdateAllowed(pin, 'Windows 11, version 26H2')).toBe(false);
    expect(featureUpdateAllowed(pin, 'Windows 11, version 24H2')).toBe(false);
    expect(featureUpdateAllowed(pin, 'Feature update to Windows 10, version 22H2')).toBe(false);
    expect(featureUpdateAllowed(pin, 'Some optional upgrade')).toBe(false);
  });
});
