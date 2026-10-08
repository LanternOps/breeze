import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { DeviceHierarchyMismatchError, hierarchyFor, withHierarchy, type DeviceHierarchy } from './deviceHierarchy';

const hierarchy: DeviceHierarchy = {
  deviceId: 'device-a',
  orgId: 'org-1',
  siteId: 'site-1',
  deviceRole: 'workstation',
  osType: 'windows',
  org: { partnerId: 'partner-1', type: 'customer' },
  site: { id: 'site-1', name: 'HQ', timezone: 'UTC' },
  groupIds: ['g-1'],
};

describe('hierarchyFor (#8053 W1a-1)', () => {
  it('returns undefined when the caller passed no hierarchy (the resolver loads its own)', () => {
    expect(hierarchyFor('device-a', undefined)).toBeUndefined();
    expect(hierarchyFor('device-a', {})).toBeUndefined();
  });

  it('returns the same object for the device it describes', () => {
    expect(hierarchyFor('device-a', { hierarchy })).toBe(hierarchy);
  });

  it('refuses a hierarchy that describes a different device', () => {
    expect(() => hierarchyFor('device-b', { hierarchy })).toThrow(DeviceHierarchyMismatchError);
    expect(() => hierarchyFor('device-b', { hierarchy })).toThrow(/device-a.*device-b/);
  });
});

describe('withHierarchy', () => {
  it('maps null to undefined so a resolver call reads exactly as before', () => {
    expect(withHierarchy(null)).toBeUndefined();
    expect(withHierarchy(hierarchy)).toEqual({ hierarchy });
  });
});
