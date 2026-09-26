import { describe, expect, it } from 'vitest';
import { projectTopology } from './projectors';
import { buildPhysicalIdentityIndex, resolveTypedNode } from './physicalIdentity';
import { physicalChassisClaimsOf } from './physicalPublication';
import { fixtureState, physicalRows as r, physicalSnapshotInput, SWITCH } from './physicalFixtures';

/** M2 Task 6b item 7: a target's own LLDP chassis (reported on its interfaces section) names it. */
const BASE = { A: '02:00:00:00:ba:5a', B: '02:00:00:00:ba:5b' } as const;

describe('LLDP chassis resolution through target identity', () => {
  it('two switches whose chassis are base MACs matching no interface MAC resolve to one physical_link', () => {
    const state = fixtureState(['A', 'B'], [1]);
    const chassisIds = [{ nodeId: SWITCH.A, id: { subtype: 'mac_address', value: BASE.A } }, { nodeId: SWITCH.B, id: { subtype: 'mac_address', value: BASE.B } }];
    const input = (sw: 'A' | 'B', peer: 'A' | 'B') => {
      const i = physicalSnapshotInput(sw, { kind: 'lldp', rows: [r.lldp(1, { chassisMac: BASE[peer] }, 1)] }, state);
      return { ...i, physical: { ...i.physical!, chassisIds } };
    };
    // Without the target claims the base MAC resolves nothing: candidate only.
    const bare = physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, { chassisMac: BASE.B }, 1)] }, state);
    expect(projectTopology(bare).relationships.map(x => x.kind)).toEqual(['attachment']);
    const a = projectTopology(input('A', 'B')), b = projectTopology(input('B', 'A'));
    expect(a.relationships.map(x => x.kind)).toEqual(['physical_link']);
    expect(b.relationships.map(x => x.kind)).toEqual(['physical_link']);
    expect(a.relationships[0]!.canonicalKey).toBe(b.relationships[0]!.canonicalKey);
    expect(new Set([a.relationships[0]!.sourceNodeId, a.relationships[0]!.targetNodeId])).toEqual(new Set([SWITCH.A, SWITCH.B]));
  });

  it('a typed non-MAC chassis resolves only by exact typed equality, and a chassis two targets claim resolves nothing', () => {
    const index = buildPhysicalIdentityIndex({ interfaces: [], deviceMacs: [], chassisIds: [
      { nodeId: SWITCH.A, id: { subtype: 'local', value: 'sw-a' } }, { nodeId: SWITCH.B, id: { subtype: 'local', value: 'dup' } }, { nodeId: SWITCH.A, id: { subtype: 'local', value: 'dup' } },
    ] });
    expect(resolveTypedNode(index, { subtype: 'local', value: 'sw-a' })).toBe(SWITCH.A);
    expect(resolveTypedNode(index, { subtype: 'interface_name', value: 'sw-a' })).toBeNull();
    expect(resolveTypedNode(index, { subtype: 'local', value: 'dup' })).toBeNull();
    // CDP device ids are a different namespace and never resolve through LLDP chassis claims.
    expect(resolveTypedNode(index, { subtype: 'cdp_device_id', value: 'sw-a' })).toBeNull();
  });

  it('claims come only from live positive snmp_interfaces baselines, attributed to their target subject', () => {
    const baseline = (protocol: string, contextKey: string, section: Record<string, unknown>, revokedAt: Date | null = null) =>
      ({ source: { id: contextKey + protocol, protocol, contextKey, revokedAt }, baseline: { section: { kind: protocol, outcome: 'complete', ...section } } });
    const subjects: Record<string, string> = { 'snmp:192.0.2.1': SWITCH.A, 'snmp:192.0.2.2': SWITCH.B };
    const claims = physicalChassisClaimsOf([
      baseline('snmp_interfaces', 'snmp:192.0.2.1/default', { localChassis: { subtype: 'mac_address', value: BASE.A } }),
      baseline('snmp_interfaces', 'snmp:192.0.2.2/default', { localChassis: { subtype: 'mac_address', value: BASE.B } }, new Date()),
      baseline('snmp_interfaces', 'snmp:192.0.2.3/default', { outcome: 'failed', localChassis: { subtype: 'mac_address', value: '02:00:00:00:ba:5c' } }),
      baseline('lldp', 'snmp:192.0.2.1/default', { localChassis: { subtype: 'mac_address', value: '02:00:00:00:ba:5d' } }),
    ], authority => subjects[authority] ?? null);
    expect(claims).toEqual([{ nodeId: SWITCH.A, id: { subtype: 'mac_address', value: BASE.A } }]);
  });
});
