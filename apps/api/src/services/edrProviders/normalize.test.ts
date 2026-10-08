import { describe, expect, it } from 'vitest';
import {
  bucketSeverity, bucketStatus, isOpenDetectionStatus, normalizeMac, normalizeMacs,
  osPlatformFromName, parseVendorDate,
} from './normalize';

describe('edr normalize', () => {
  it('maps an unknown vendor severity/status to unknown, never throws', () => {
    expect(bucketSeverity({ high: 'high' }, 'ultra')).toBe('unknown');
    expect(bucketStatus({ 1: 'open' }, 99)).toBe('unknown');
    expect(bucketSeverity({}, null)).toBe('unknown');
    expect(bucketSeverity({ high: 'high' }, 'high')).toBe('high');
    expect(bucketStatus({ 1: 'open' }, 1)).toBe('open');
    expect(bucketSeverity({}, '__proto__')).toBe('unknown');
    expect(bucketStatus({}, 'constructor')).toBe('unknown');
  });

  it('normalizes MACs to lower-case colon form and drops garbage', () => {
    expect(normalizeMacs(['AA-BB-CC-DD-EE-FF', 'aabbccddeeff', 'zz', null])).toEqual(['aa:bb:cc:dd:ee:ff']);
    expect(normalizeMacs('nope')).toEqual([]);
    expect(normalizeMac('AA:BB:CC:DD:EE:0F')).toBe('aa:bb:cc:dd:ee:0f');
    expect(normalizeMac('xyz')).toBeNull();
  });

  it('parses vendor dates defensively', () => {
    expect(parseVendorDate('2026-10-01T10:00:00Z')?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(parseVendorDate('not a date')).toBeNull();
    expect(parseVendorDate(null)).toBeNull();
    expect(parseVendorDate({})).toBeNull();
    expect(parseVendorDate(1790000000)?.getUTCFullYear()).toBe(2026);
  });

  it('derives os platform and open-ness', () => {
    expect(osPlatformFromName('Windows Server 2022')).toBe('windows');
    expect(osPlatformFromName('Ubuntu 22.04')).toBe('linux');
    expect(osPlatformFromName('macOS 14')).toBe('macos');
    expect(osPlatformFromName(null)).toBe('other');
    expect(isOpenDetectionStatus('open')).toBe(true);
    expect(isOpenDetectionStatus('resolved')).toBe(false);
  });
});
