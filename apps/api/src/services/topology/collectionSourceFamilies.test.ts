import { describe, expect, it } from 'vitest';
import { topologyPositiveKeys, topologyFactKey } from './collectionFactKeys';
import {
  assertTopologyProducerFamily, isWithinTopologyAuthority, topologyAuthorityContextKey, topologySourceFamily,
  type NormalizedTopologySnapshot,
} from './collectionTypes';

type Section = NormalizedTopologySnapshot['section'];
const base = { contextKey: 'snmp:192.0.2.10/default', contentDigest: 'a'.repeat(64), outcome: 'complete' as const };
const lldp = { ...base, kind: 'lldp', rowCount: 2, rows: [
  { rowKey: '7.1', timeMark: 1, remoteIndex: 1, localPort: { namespace: 'lldp_local', value: '7', resolvedInterfaceKey: null }, remoteChassis: { subtype: 'mac_address', value: '02:00:00:00:00:01' }, remotePort: { subtype: 'interface_name', value: 'Gi0/1' } },
  { rowKey: '8.2', timeMark: 1, remoteIndex: 2, localPort: { namespace: 'lldp_local', value: '8', resolvedInterfaceKey: null }, remoteChassis: { subtype: 'local', value: 'x' }, remotePort: { subtype: 'local', value: 'y' } },
] } as unknown as Section;
const fdb = { ...base, kind: 'fdb', rowCount: 2, metadata: { ineligibleRowCount: 3, sharedPortCount: 1, collapsedRowCount: 40 }, rows: [
  { rowKey: 'default|700|02:00:00:00:00:09|7', bridgeContext: 'default', fdbId: 700, mac: '02:00:00:00:00:09', bridgePort: 7, ifIndex: 107, status: 'learned', vlans: [10], vlanMapping: 'complete' },
  { rowType: 'shared_port', rowKey: 'shared_port|default|8', bridgeContext: 'default', bridgePort: 8, ifIndex: 108, sizeBucket: '17-64' },
] } as unknown as Section;
const osInterfaces = { contextKey: 'main', contentDigest: 'a'.repeat(64), outcome: 'complete', kind: 'interfaces', rowCount: 1, rows: [
  { rowKey: 'eth0', interfaceKey: 'eth0', osIndex: 1, name: 'eth0', kind: 'ethernet', adminState: 'up', operState: 'up', mtu: 1500,
    addresses: [{ address: '192.0.2.5', prefixLength: 24, family: 'ipv4', zone: null, state: 'preferred', assignment: 'dhcp' }] },
] } as unknown as Section;

describe('typed topology source families (D15.4)', () => {
  it('maps every section kind to exactly one family and rejects unknown kinds', () => {
    expect(topologySourceFamily('interfaces')).toBe('os_context');
    expect(topologySourceFamily('neighbors')).toBe('os_context');
    for (const kind of ['lldp', 'cdp', 'fdb', 'snmp_interfaces']) expect(topologySourceFamily(kind)).toBe('adjacency');
    for (const kind of ['unifi_device_list', 'unifi_client_list', 'unifi_device_details', 'unifi_statistics']) expect(topologySourceFamily(kind)).toBe('unifi');
    expect(() => topologySourceFamily('envelope')).toThrow('unsupported_source_family');
    expect(() => topologySourceFamily('device_list')).toThrow('unsupported_source_family');
  });
  it('binds each producer kind to its own family', () => {
    expect(() => assertTopologyProducerFamily('agent', 'routes')).not.toThrow();
    expect(() => assertTopologyProducerFamily('discovery', 'fdb')).not.toThrow();
    expect(() => assertTopologyProducerFamily('unifi', 'unifi_client_list')).not.toThrow();
    expect(() => assertTopologyProducerFamily('agent', 'lldp')).toThrow('unsupported_source_family');
    expect(() => assertTopologyProducerFamily('discovery', 'interfaces')).toThrow('unsupported_source_family');
    expect(() => assertTopologyProducerFamily('discovery', 'unifi_device_list')).toThrow('unsupported_source_family');
    expect(() => assertTopologyProducerFamily('unifi', 'lldp')).toThrow('unsupported_source_family');
    expect(() => assertTopologyProducerFamily('snmp', 'lldp')).toThrow('unsupported_source_family');
  });
  it('namespaces physical source contexts under the server-derived authority key', () => {
    expect(topologyAuthorityContextKey('snmp:192.0.2.10', 'default')).toBe('snmp:192.0.2.10/default');
    expect(topologyAuthorityContextKey('c1:site-a')).toBe('c1:site-a');
    expect(isWithinTopologyAuthority('snmp:192.0.2.10', 'snmp:192.0.2.10/default')).toBe(true);
    expect(isWithinTopologyAuthority('c1:site-a', 'c1:site-a')).toBe(true);
    expect(isWithinTopologyAuthority('snmp:192.0.2.10', 'snmp:192.0.2.100/default')).toBe(false);
    expect(isWithinTopologyAuthority('snmp:192.0.2.10', 'default')).toBe(false);
  });
});

describe('positive fact keys dispatch by family', () => {
  it('keeps M1 OS interface keys (row + active address facts)', () => {
    expect(topologyPositiveKeys(osInterfaces)).toEqual(['eth0', topologyFactKey('eth0', ['192.0.2.5', 24, null])]);
  });
  it('uses physical row keys verbatim', () => {
    expect(topologyPositiveKeys(lldp)).toEqual(['7.1', '8.2']);
  });
  it('keeps both per-MAC and shared_port FDB rows as withdrawable facts', () => {
    expect(topologyPositiveKeys(fdb)).toEqual(['default|700|02:00:00:00:00:09|7', 'shared_port|default|8']);
  });
  it('never reads OS row fields from an SNMP interface section', () => {
    const snmp = { ...base, kind: 'snmp_interfaces', rowCount: 1, rows: [{ rowKey: '7', interfaceKey: 'if:7', ifIndex: 7, ifName: 'Gi0/7', ifAlias: null, physAddress: null, lldpLocalPort: 7, bridgePort: 7 }] } as unknown as Section;
    expect(topologyPositiveKeys(snmp)).toEqual(['7']);
  });
  it('treats a unifi resource as one fact per row', () => {
    const unifi = { ...base, contextKey: 'c1:site-a', kind: 'unifi_client_list', rowCount: 1, rows: [{ rowKey: 'client-1' }] } as unknown as Section;
    expect(topologyPositiveKeys(unifi)).toEqual(['client-1']);
  });
});
