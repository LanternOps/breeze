import { describe, expect, it } from 'vitest';
import { alertOwnerKey, isDeviceOwned, type AlertOwnerFields } from './alertOwner';

const device: AlertOwnerFields = {
  ownerKind: 'device', ownerRef: null, deviceId: 'd1',
  topologySiteId: null, topologySourceKey: null,
};

describe('alertOwnerKey', () => {
  it('includes the alert id when rejecting illegal ownership', () => {
    expect(() => alertOwnerKey({ ...device, id: 'broken-alert-1', deviceId: null }))
      .toThrow('broken-alert-1');
  });
  it('returns device:d1 for a device owner', () => {
    expect(alertOwnerKey(device)).toBe('device:d1');
  });
  it.each(['d1', null])('returns topology:s1:k1 with provenance device %s', deviceId => {
    expect(alertOwnerKey({ ...device, ownerKind: 'topology_site', deviceId,
      topologySiteId: 's1', topologySourceKey: 'k1' })).toBe('topology:s1:k1');
  });
  it('returns backup_workload:r1 for an org owner', () => {
    expect(alertOwnerKey({ ...device, ownerKind: 'backup_workload', ownerRef: 'r1', deviceId: null }))
      .toBe('backup_workload:r1');
  });
  it.each([
    { ...device, deviceId: null },
    { ...device, ownerKind: 'backup_workload' as const, ownerRef: null, deviceId: null },
    { ...device, ownerKind: 'backup_workload' as const, ownerRef: 'r1' },
    { ...device, ownerKind: 'topology_site' as const, topologySourceKey: 'k1' },
    { ...device, ownerKind: 'topology_site' as const, topologySiteId: 's1' },
  ])('rejects illegal owner fields %j', fields => {
    expect(() => alertOwnerKey(fields)).toThrow('Invalid alert owner');
  });
});

describe('isDeviceOwned', () => {
  it.each([['d1', true], [null, false]] as const)('narrows deviceId %s', (deviceId, expected) => {
    expect(isDeviceOwned({ deviceId })).toBe(expected);
  });
});
