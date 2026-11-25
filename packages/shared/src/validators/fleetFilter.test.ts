import { describe, expect, it } from 'vitest';
import { FLEET_FILTER_GROUP_BY, fleetFilterSchema } from './fleetFilter';
import * as barrel from './index';

const SITE = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';

const ALL_FLEET_FILTER_FIELDS = {
  status: 'online',
  osType: 'windows',
  osVersionContains: '11',
  hostnameContains: 'web',
  siteId: SITE,
  groupId: GROUP,
  tags: ['pci'],
  agentVersion: '0.130.0',
  softwareInstalled: '7-Zip',
  softwareMissing: 'CrowdStrike',
  softwareVersionBelow: { name: '7-Zip', version: '23.01' },
  pendingPatches: true,
  criticalAlerts: false,
  rebootRequired: true,
  lastSeenDaysOver: 30,
} as const;

describe('fleetFilterSchema', () => {
  it('accepts every documented field at once', () => {
    expect(Object.keys(ALL_FLEET_FILTER_FIELDS)).toHaveLength(15);
    const parsed = fleetFilterSchema.safeParse(ALL_FLEET_FILTER_FIELDS);
    expect(parsed.success).toBe(true);
    expect(Object.keys(fleetFilterSchema.shape).sort()).toEqual(Object.keys(ALL_FLEET_FILTER_FIELDS).sort());
  });

  it('accepts an empty filter (every field optional)', () => {
    expect(fleetFilterSchema.safeParse({}).success).toBe(true);
  });

  it('is strict: an unknown key is refused', () => {
    expect(fleetFilterSchema.safeParse({ hostname: 'x' }).success).toBe(false);
  });

  it('refuses decommissioned as a status', () => {
    expect(fleetFilterSchema.safeParse({ status: 'decommissioned' }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ status: 'quarantined' }).success).toBe(true);
  });

  it('bounds tags to 20 entries of 100 chars', () => {
    expect(fleetFilterSchema.safeParse({ tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }).success).toBe(true);
    expect(fleetFilterSchema.safeParse({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ tags: ['x'.repeat(100)] }).success).toBe(true);
    expect(fleetFilterSchema.safeParse({ tags: ['x'.repeat(101)] }).success).toBe(false);
  });

  it('requires both name and version for softwareVersionBelow, and the version starts with a digit', () => {
    expect(fleetFilterSchema.safeParse({ softwareVersionBelow: { name: '7-Zip' } }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ softwareVersionBelow: { name: '7-Zip', version: 'latest' } }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ softwareVersionBelow: { name: '7-Zip', version: '23.01' } }).success).toBe(true);
    expect(fleetFilterSchema.safeParse({ softwareVersionBelow: { name: '7-Zip', version: '23', extra: 1 } }).success).toBe(false);
  });

  it('refuses empty strings, a non-uuid siteId/groupId and an out-of-range lastSeenDaysOver', () => {
    expect(fleetFilterSchema.safeParse({ hostnameContains: '' }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ siteId: 'site-1' }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ groupId: 'Servers' }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ lastSeenDaysOver: 0 }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ lastSeenDaysOver: 3651 }).success).toBe(false);
    expect(fleetFilterSchema.safeParse({ lastSeenDaysOver: 1.5 }).success).toBe(false);
  });

  it('every description is present and at most 160 chars', () => {
    for (const [key, field] of Object.entries(fleetFilterSchema.shape)) {
      const d = (field as { description?: string }).description;
      expect(d, key).toBeTruthy();
      expect(d!.length, key).toBeLessThanOrEqual(160);
    }
  });

  it('FLEET_FILTER_GROUP_BY names only device-scalar columns', () => {
    expect(FLEET_FILTER_GROUP_BY).toEqual(['status', 'osType', 'osVersion', 'siteId', 'agentVersion', 'deviceRole', 'architecture']);
  });

  it('is exported from the validators barrel', () => {
    expect(barrel.fleetFilterSchema).toBe(fleetFilterSchema);
    expect(barrel.FLEET_FILTER_GROUP_BY).toBe(FLEET_FILTER_GROUP_BY);
  });
});
