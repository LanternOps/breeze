/**
 * TEST-ONLY physical projection fixtures (M2 Task 6). Pure data: no database or
 * network access; imported only by tests. Physical projection is per snapshot
 * (D15), so a fixture is an ordered list of projector inputs — one per source
 * snapshot — that a test folds exactly as publication does.
 */
import type { CdpRow, FdbRow, LldpRow, PhysicalInterfaceRow } from '@breeze/shared';
import type { AdjacencyTopologySnapshot } from './collectionTypes';
import type { CollectionRun, CollectionSource, InterfacePublication, TopologyProjectionDelta, TopologyProjectionInput } from './reconciliationTypes';
import type { NodePublication, RelationshipPublication } from './publish';
import { canonicalIdentityKey } from './identity';

export const FIXTURE_SCOPE = { orgId: '0f000000-0000-4000-8000-000000000001', siteId: '0f000000-0000-4000-8000-000000000002' };
export const SWITCH = {
  A: '0a000000-0000-4000-8000-00000000000a', B: '0a000000-0000-4000-8000-00000000000b', C: '0a000000-0000-4000-8000-00000000000c',
} as const;
export const CLIENT = '0c000000-0000-4000-8000-000000000001';
export const CLIENT_MAC = '02:00:00:00:cc:01';
export const CLIENT2_MAC = '02:00:00:00:cc:02';
export const SWITCH_IP = { A: '192.0.2.1', B: '192.0.2.2', C: '192.0.2.3' } as const;
type Switch = keyof typeof SWITCH;
export const portMac = (sw: Switch, port: number) => `02:00:00:0${'ABC'.indexOf(sw) + 1}:00:${port.toString(16).padStart(2, '0')}`;
const uuid = (tag: number) => `0e000000-0000-4000-8000-${tag.toString(16).padStart(12, '0')}`;

export const physicalRows = {
  lldp: (port: number, remote: Switch | { chassisMac: string }, remotePort: number, remoteIndex = 1, extra: Partial<LldpRow> = {}): LldpRow => ({
    rowKey: `${port}.${remoteIndex}`, timeMark: 100, remoteIndex,
    localPort: { namespace: 'lldp_local', value: String(port), resolvedInterfaceKey: `name:Gi0/${port}` },
    remoteChassis: { subtype: 'mac_address', value: typeof remote === 'string' ? portMac(remote, 1) : remote.chassisMac },
    remotePort: { subtype: 'interface_name', value: `Gi0/${remotePort}` }, ...extra,
  }),
  cdp: (ifIndex: number, remote: Switch, remotePort: number, deviceIndex = 1): CdpRow => ({
    rowKey: `${ifIndex}.${deviceIndex}`, deviceIndex, localPort: { namespace: 'if_index', value: String(ifIndex), resolvedInterfaceKey: null },
    remoteDevice: { subtype: 'mac_address', value: portMac(remote, 1) }, remotePort: { subtype: 'interface_name', value: `Gi0/${remotePort}` },
  }),
  fdb: (port: number, mac: string, vlans: number[] = [10]): FdbRow => ({
    rowKey: `default|700|${mac}|${port}`, bridgeContext: 'default', fdbId: 700, mac, bridgePort: port, ifIndex: port, status: 'learned', vlans, vlanMapping: 'complete',
  }),
  iface: (sw: Switch, port: number, mac: string | null = portMac(sw, port)): PhysicalInterfaceRow => ({
    rowKey: String(port), interfaceKey: `name:Gi0/${port}`, ifIndex: port, ifName: `Gi0/${port}`, ifAlias: null, physAddress: mac, lldpLocalPort: port, bridgePort: port,
  }),
};

const node = (id: string, label: string): NodePublication => ({ ...FIXTURE_SCOPE, id, kind: 'endpoint', identityKey: canonicalIdentityKey(FIXTURE_SCOPE, 'endpoint', id), identityMaterial: { version: 1, kind: 'endpoint', sourceKey: id }, attributes: { label }, lifecycle: 'active' });
export const fixtureInterface = (sw: Switch, port: number, epoch = 'gen:1', mac: string | null = portMac(sw, port)): InterfacePublication => ({
  ...FIXTURE_SCOPE, id: uuid(('ABC'.indexOf(sw) + 1) * 1000 + port * 10 + Number(epoch.slice(4) || 0)), ownerNodeId: SWITCH[sw], interfaceKey: `name:Gi0/${port}`, epoch,
  kind: 'unknown', name: `Gi0/${port}`, osIndex: String(port), physAddress: mac, addresses: [],
});

let runTag = 100;
type Section = AdjacencyTopologySnapshot['section'];
export function physicalSnapshotInput(sw: Switch, section: Record<string, unknown> & { kind: string }, state: FixtureState, options: { sequence?: string; effectiveAt?: Date; subjectResolved?: boolean } = {}): TopologyProjectionInput {
  const authorityKey = `snmp:${SWITCH_IP[sw]}`;
  const contextKey = `${authorityKey}/default`;
  const rows = (section.rows as unknown[]) ?? [];
  const full = { contextKey, contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: rows.length, ...section } as unknown as Section;
  const effectiveAt = options.effectiveAt ?? new Date('2026-09-25T12:00:00.000Z');
  const sourceId = uuid(('ABC'.indexOf(sw) + 1) * 100 + ['lldp', 'cdp', 'fdb', 'snmp_interfaces'].indexOf(section.kind));
  const source = { ...FIXTURE_SCOPE, id: sourceId, producerId: uuid(9), producerKind: 'discovery', producerEpoch: 'epoch-1', protocol: section.kind, contextKey, addressFamily: 'any' } as unknown as CollectionSource;
  const run = { ...FIXTURE_SCOPE, id: uuid(runTag++), sourceId, sequence: options.sequence ?? '1', contentDigest: 'a'.repeat(64), effectiveAt, observedAt: effectiveAt, receivedAt: effectiveAt, expectedIntervalSeconds: 3600 } as unknown as CollectionRun;
  const snapshot: AdjacencyTopologySnapshot = {
    key: { protocol: section.kind, contextKey, addressFamily: 'any' }, snapshotId: uuid(runTag++), producerEpoch: 'epoch-1', sequence: run.sequence,
    capturedAt: effectiveAt.toISOString(), captureAgeAtSendMs: 0, expectedIntervalSeconds: 3600, contentDigest: 'a'.repeat(64),
    manifest: { contract: 'adjacency_v2', target: { sourceKey: authorityKey, address: SWITCH_IP[sw], zone: null }, scopes: [] }, section: full,
  };
  return { scope: FIXTURE_SCOPE, source, run, snapshot, originNodeId: null, nodes: [...state.nodes.values()], relationships: [...state.relationships.values()], interfaces: [...state.interfaces.values()],
    physical: { authorityKey, subjectNodeId: options.subjectResolved === false ? null : SWITCH[sw], deviceMacs: state.deviceMacs } };
}

export type FixtureState = { nodes: Map<string, NodePublication>; relationships: Map<string, RelationshipPublication>; interfaces: Map<string, InterfacePublication>; deviceMacs: { nodeId: string; mac: string }[] };
export function fixtureState(switches: Switch[], ports: number[], deviceMacs: { nodeId: string; mac: string }[] = [], withInterfaces: Switch[] = switches): FixtureState {
  const nodes = new Map<string, NodePublication>(switches.map(sw => [SWITCH[sw], node(SWITCH[sw], `switch-${sw}`)]));
  nodes.set(CLIENT, node(CLIENT, 'client'));
  const interfaces = new Map<string, InterfacePublication>();
  for (const sw of withInterfaces) for (const port of ports) { const row = fixtureInterface(sw, port); interfaces.set(row.id, row); }
  return { nodes, relationships: new Map(), interfaces, deviceMacs };
}
/** Fold a delta the way prepareCollectionPublication does. */
export function applyFixtureDelta(state: FixtureState, delta: TopologyProjectionDelta) {
  for (const row of delta.nodes) state.nodes.set(row.id, row);
  for (const row of delta.interfaces) state.interfaces.set(row.id, row);
  for (const row of delta.relationships) state.relationships.set(row.id, row);
}

export type PhysicalFixtureName = 'reciprocal-parallel' | 'ambiguous-fdb' | 'lag-cycle' | 'identity-enrichment';
export type PhysicalFixture = { state: FixtureState; inputs: ((state: FixtureState) => TopologyProjectionInput)[] };
const r = physicalRows;
export function physicalFixture(name: PhysicalFixtureName): PhysicalFixture {
  switch (name) {
    // Two switches, three real port pairs: A1-B1 and A2-B2 reported by LLDP and
    // CDP from both ends (four independent supports each); A3 sees a neighbour
    // whose chassis is not inventory and whose port cannot resolve.
    case 'reciprocal-parallel': return { state: fixtureState(['A', 'B'], [1, 2, 3]), inputs: [
      s => physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, 'B', 1), r.lldp(2, 'B', 2), r.lldp(3, { chassisMac: '02:00:00:00:ee:01' }, 9)] }, s),
      s => physicalSnapshotInput('A', { kind: 'cdp', rows: [r.cdp(1, 'B', 1), r.cdp(2, 'B', 2)] }, s),
      s => physicalSnapshotInput('B', { kind: 'lldp', rows: [r.lldp(1, 'A', 1), r.lldp(2, 'A', 2)] }, s),
      s => physicalSnapshotInput('B', { kind: 'cdp', rows: [r.cdp(1, 'A', 1), r.cdp(2, 'A', 2)] }, s),
    ] };
    // One client MAC learned on A5 and B7 (neither port is infrastructure): no
    // selected parent. A second client is learned on A6 and on B1, and B1 is the
    // measured uplink to A1: only A6 is eligible, so it is selected.
    case 'ambiguous-fdb': return { state: fixtureState(['A', 'B'], [1, 5, 6, 7], [{ nodeId: CLIENT, mac: CLIENT_MAC }]), inputs: [
      s => physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, 'B', 1)] }, s),
      s => physicalSnapshotInput('A', { kind: 'fdb', rows: [r.fdb(5, CLIENT_MAC), r.fdb(6, CLIENT2_MAC)], metadata: { ineligibleRowCount: 0, sharedPortCount: 0, collapsedRowCount: 0 } }, s),
      s => physicalSnapshotInput('B', { kind: 'fdb', rows: [r.fdb(7, CLIENT_MAC), r.fdb(1, CLIENT2_MAC)], metadata: { ineligibleRowCount: 0, sharedPortCount: 0, collapsedRowCount: 0 } }, s),
    ] };
    // Three-switch cycle A-B-C-A plus a two-member A-B LAG (A1-B1, A2-B2). No
    // spanning-tree pruning and no LAG deduplication: four distinct links.
    case 'lag-cycle': return { state: fixtureState(['A', 'B', 'C'], [1, 2, 3]), inputs: [
      s => physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, 'B', 1), r.lldp(2, 'B', 2), r.lldp(3, 'C', 2)] }, s),
      s => physicalSnapshotInput('B', { kind: 'lldp', rows: [r.lldp(3, 'C', 1)] }, s),
      s => physicalSnapshotInput('C', { kind: 'lldp', rows: [r.lldp(1, 'B', 3), r.lldp(2, 'A', 3)] }, s),
    ] };
    // A reports B before B's interface inventory exists; B's interfaces arrive later.
    case 'identity-enrichment': return { state: fixtureState(['A', 'B'], [1], [], ['A']), inputs: [
      s => physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, 'B', 1)] }, s),
      s => physicalSnapshotInput('B', { kind: 'snmp_interfaces', rows: [r.iface('B', 1)] }, s),
    ] };
  }
}
