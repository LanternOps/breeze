import { describe, expect, it } from 'vitest';
import {
  buildPhysicalIdentityIndex, interfaceContinuity, normalizeMac, physicalLinkKey, planInterfaceGeneration, resolveLocalInterface,
  resolvePhysicalSubjectAsset, resolveRemoteInterface, resolveTypedNode, lldpChassisSourceKey, physicalAuthorityOf,
} from './physicalIdentity';
import { canonicalIdentityKey } from './identity';

const scope = { orgId: '11111111-1111-4111-8111-111111111111', siteId: '22222222-2222-4222-8222-222222222222' };

describe('physicalLinkKey', () => {
  const a1 = { nodeId: 'A', interfaceId: 'A1' }, b1 = { nodeId: 'B', interfaceId: 'B1' };
  const a2 = { nodeId: 'A', interfaceId: 'A2' }, b2 = { nodeId: 'B', interfaceId: 'B2' };
  it('is order independent and keeps parallel cables distinct', () => {
    expect(physicalLinkKey(a1, b1)).toBe(physicalLinkKey(b1, a1));
    expect(physicalLinkKey(a1, b1)).not.toBe(physicalLinkKey(a2, b2));
    expect(physicalLinkKey(a1, b2)).not.toBe(physicalLinkKey(a2, b1));
  });
  it('is a prefixed source key accepted by canonicalIdentityKey', () => {
    const key = physicalLinkKey(a1, b1);
    expect(key).toBe('physical-link-v1:A:A1:B:B1');
    expect(canonicalIdentityKey(scope, 'physical_link', key)).toMatch(/^v1:[0-9a-f]{64}$/);
  });
  it('encodes unbound chassis identities without whitespace', () => {
    const key = lldpChassisSourceKey({ subtype: 'chassis_component', value: 'Core Switch 1' });
    expect(key).toBe('lldp-chassis:chassis_component:Core%20Switch%201');
    expect(() => canonicalIdentityKey(scope, 'endpoint', key)).not.toThrow();
  });
});

describe('interface generations (D10)', () => {
  const ev = (name: string | null, physAddress: string | null, osIndex: string | null = '7') => ({ name, physAddress, osIndex });
  it('proves continuity only with both name and MAC present and equal', () => {
    expect(interfaceContinuity(ev('Gi0/7', '02:00:00:00:00:07'), ev('Gi0/7', '02-00-00-00-00-07'))).toBe('continuous');
    expect(interfaceContinuity(ev('Gi0/7', null), ev('Gi0/7', null))).toBe('unproven');
    expect(interfaceContinuity(ev('Gi0/7', '02:00:00:00:00:07'), ev('Gi0/7', null))).toBe('unproven');
    expect(interfaceContinuity(ev('Gi0/7', '02:00:00:00:00:07'), ev('Gi0/8', '02:00:00:00:00:07'))).toBe('conflict');
    expect(interfaceContinuity(ev('Gi0/7', '02:00:00:00:00:07'), ev('Gi0/7', '02:00:00:00:00:99'))).toBe('conflict');
  });
  it('keeps a continuous generation even when the ifIndex is renumbered', () => {
    expect(planInterfaceGeneration(ev('Gi0/7', '02:00:00:00:00:07', '7'), 1, ev('Gi0/7', '02:00:00:00:00:07', '107'))).toEqual({ action: 'keep' });
  });
  it('retires a conflicting generation and allocates the next epoch', () => {
    expect(planInterfaceGeneration(ev('Gi0/7', '02:00:00:00:00:07'), 3, ev('Gi0/7', '02:00:00:00:00:99'))).toEqual({ action: 'allocate', epoch: 'gen:4', retireCurrent: true });
  });
  it('never lets missing evidence establish continuity', () => {
    // MAC appears where none was known: nothing corroborates the old identity.
    expect(planInterfaceGeneration(ev('Gi0/7', null), 1, ev('Gi0/7', '02:00:00:00:00:07'))).toEqual({ action: 'allocate', epoch: 'gen:2', retireCurrent: true });
    // MAC vanishes.
    expect(planInterfaceGeneration(ev('Gi0/7', '02:00:00:00:00:07'), 1, ev('Gi0/7', null))).toEqual({ action: 'allocate', epoch: 'gen:2', retireCurrent: true });
    // An ifIndex reused by a MAC-less interface with another index is a new generation.
    expect(planInterfaceGeneration(ev('Gi0/7', null, '7'), 1, ev('Gi0/7', null, '9'))).toEqual({ action: 'allocate', epoch: 'gen:2', retireCurrent: true });
  });
  it('keeps an exactly repeated uncorroborated tuple (no evidence of change)', () => {
    expect(planInterfaceGeneration(ev('Vlan10', null), 1, ev('Vlan10', null))).toEqual({ action: 'keep' });
  });
  it('allocates the first generation', () => {
    expect(planInterfaceGeneration(null, 0, ev('Gi0/7', null))).toEqual({ action: 'allocate', epoch: 'gen:1', retireCurrent: false });
  });
});

describe('typed resolution', () => {
  const index = buildPhysicalIdentityIndex({
    interfaces: [
      { id: 'b1', ownerNodeId: 'B', interfaceKey: 'name:Gi0/1', epoch: 'gen:1', name: 'Gi0/1', alias: 'uplink', osIndex: '1', physAddress: '02:00:00:00:0b:01' },
      { id: 'b1old', ownerNodeId: 'B', interfaceKey: 'name:Gi0/1', epoch: 'gen:0', name: 'Gi0/1', osIndex: '1', physAddress: '02:00:00:00:0b:99', retiredAt: new Date() },
      { id: 'os', ownerNodeId: 'C', interfaceKey: 'eth0', epoch: 'b9c2c7f4-0000-4000-8000-000000000000', name: 'eth0', osIndex: '1', physAddress: '02:00:00:00:0c:01' },
      { id: 'dup1', ownerNodeId: 'D', interfaceKey: 'name:x', epoch: 'gen:1', name: 'x', physAddress: '02:00:00:00:dd:01' },
      { id: 'dup2', ownerNodeId: 'E', interfaceKey: 'name:x', epoch: 'gen:1', name: 'x', physAddress: '02:00:00:00:dd:01' },
    ],
    deviceMacs: [{ nodeId: 'F', mac: '02-00-00-00-0F-01' }, { nodeId: 'G', mac: 'ff:ff:ff:ff:ff:ff' }],
  });
  it('resolves nodes only by unique MAC (agent NIC or current SNMP interface MAC)', () => {
    expect(resolveTypedNode(index, { subtype: 'mac_address', value: '02:00:00:00:0b:01' })).toBe('B');
    expect(resolveTypedNode(index, { subtype: 'mac_address', value: '02:00:00:00:0f:01' })).toBe('F');
    // A retired generation's MAC is no longer identity.
    expect(resolveTypedNode(index, { subtype: 'mac_address', value: '02:00:00:00:0b:99' })).toBeNull();
    // OS interfaces are not SNMP identity; duplicate MACs are ambiguous; names never resolve.
    expect(resolveTypedNode(index, { subtype: 'mac_address', value: '02:00:00:00:0c:01' })).toBeNull();
    expect(resolveTypedNode(index, { subtype: 'mac_address', value: '02:00:00:00:dd:01' })).toBeNull();
    expect(resolveTypedNode(index, { subtype: 'chassis_component', value: 'B' })).toBeNull();
    expect(resolveTypedNode(index, { subtype: 'network_address', value: '192.0.2.10' })).toBeNull();
    expect(index.nodesByMac.has('ff:ff:ff:ff:ff:ff')).toBe(false);
  });
  it('resolves remote ports by name, alias or MAC on the current generation only', () => {
    expect(resolveRemoteInterface(index, 'B', { subtype: 'interface_name', value: 'Gi0/1' })?.id).toBe('b1');
    expect(resolveRemoteInterface(index, 'B', { subtype: 'interface_alias', value: 'uplink' })?.id).toBe('b1');
    expect(resolveRemoteInterface(index, 'B', { subtype: 'mac_address', value: '02:00:00:00:0b:01' })?.id).toBe('b1');
    expect(resolveRemoteInterface(index, 'B', { subtype: 'local', value: '1' })).toBeNull();
  });
  it('never compares numbers across port namespaces', () => {
    expect(resolveLocalInterface(index, 'B', { namespace: 'if_index', value: '1', resolvedInterfaceKey: null })?.id).toBe('b1');
    expect(resolveLocalInterface(index, 'B', { namespace: 'lldp_local', value: '1', resolvedInterfaceKey: null })).toBeNull();
    expect(resolveLocalInterface(index, 'B', { namespace: 'bridge_port', value: '1', resolvedInterfaceKey: null })).toBeNull();
    expect(resolveLocalInterface(index, 'B', { namespace: 'lldp_local', value: '1', resolvedInterfaceKey: 'name:Gi0/1' })?.id).toBe('b1');
  });
  it('normalizes MACs and rejects group/zero addresses', () => {
    expect(normalizeMac('02-00-00-00-0B-01')).toBe('02:00:00:00:0b:01');
    expect(normalizeMac('01:00:5e:00:00:01')).toBeNull();
    expect(normalizeMac('00:00:00:00:00:00')).toBeNull();
    expect(normalizeMac('garbage')).toBeNull();
  });
});

describe('subject resolution (D3)', () => {
  const assets = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ipAddress: '192.0.2.10' }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ipAddress: '192.0.2.11/32' }];
  it('resolves the authorized target to its scoped asset', () => {
    expect(resolvePhysicalSubjectAsset('snmp:192.0.2.10', assets)).toBe(assets[0]!.id);
    expect(resolvePhysicalSubjectAsset('snmp:192.0.2.11', assets)).toBe(assets[1]!.id);
    expect(resolvePhysicalSubjectAsset(`asset:${assets[1]!.id}`, assets)).toBe(assets[1]!.id);
    expect(resolvePhysicalSubjectAsset('snmp:192.0.2.99', assets)).toBeNull();
    expect(resolvePhysicalSubjectAsset('snmp:switch-a', assets)).toBeNull();
    expect(physicalAuthorityOf('snmp:192.0.2.10/default')).toBe('snmp:192.0.2.10');
  });
});
