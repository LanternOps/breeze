import { describe, expect, it } from 'vitest';

import { mapAsset, toDetail, type ApiDiscoveryAsset } from './DiscoveredAssetList';

// These guard the load-bearing transform seam for #1731: the API now projects
// snmpData, but the modal is fed through mapAsset → toDetail. If either transform
// drops snmpData/discoveryMethods, the SNMP card silently regresses to empty with
// no type error — exactly the bug class this PR fixes. The API test proves the
// server emits the fields and the modal test proves it renders an AssetDetail that
// has them; these tests prove the middle carries them through.

const apiAsset: ApiDiscoveryAsset = {
  id: 'asset-1',
  assetType: 'switch',
  approvalStatus: 'pending',
  isOnline: true,
  hostname: 'core-sw-01',
  ipAddress: '10.0.2.1',
  macAddress: 'aa:bb:cc:dd:ee:ff',
  manufacturer: 'Cisco',
  openPorts: [],
  snmpData: { sysName: 'core-sw-01', sysDescr: 'Cisco IOS', sysObjectId: '1.3.6.1.4.1.9.1.1' },
  discoveryMethods: ['ping', 'snmp'],
  lastSeenAt: '2026-06-22T00:00:00.000Z',
};

describe('DiscoveredAssetList transforms — snmpData seam (#1731)', () => {
  it('mapAsset carries snmpData and discoveryMethods through from the API DTO', () => {
    const mapped = mapAsset(apiAsset);
    expect(mapped.snmpData).toEqual(apiAsset.snmpData);
    expect(mapped.discoveryMethods).toEqual(['ping', 'snmp']);
  });

  it('toDetail preserves snmpData for the detail modal', () => {
    const detail = toDetail(mapAsset(apiAsset));
    expect(detail.snmpData).toEqual(apiAsset.snmpData);
    expect(detail.discoveryMethods).toEqual(['ping', 'snmp']);
  });

  it('toDetail coerces missing snmpData to an empty object (no undefined leak)', () => {
    const detail = toDetail(mapAsset({ ...apiAsset, snmpData: null }));
    expect(detail.snmpData).toEqual({});
  });
});
