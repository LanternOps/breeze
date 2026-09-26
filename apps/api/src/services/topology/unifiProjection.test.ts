import { describe, expect, it } from 'vitest';
import { relationshipDetailResponseSchema, unifiEndpointKey, type NormalizedUnifiClientRow, type NormalizedUnifiDeviceDetailRow, type NormalizedUnifiDeviceRow } from '@breeze/shared';
import { projectTopology } from './projectors';
import { physicalDetail, type DetailRow } from './relationshipDetail';
import { validatePublicationInput, type NodePublication, type RelationshipPublication } from './publish';
import { FIXTURE_SCOPE } from './physicalFixtures';
import { unifiEndpointDevicesOf } from './physicalPublication';
import { unifiControllerPortKey, unifiControllerPortNamespace } from './unifiPorts';
import type { CollectionRun, CollectionSource, TopologyProjectionDelta, TopologyProjectionInput } from './reconciliationTypes';

/** M2 Task 6b: UniFi normalized rows -> controller endpoint nodes and attachments. */
const COLLECTOR = '0d000000-0000-4000-8000-000000000001';
const INVENTORY_DEVICE = '0d000000-0000-4000-8000-0000000000aa';
const INVENTORY_NODE = '0d000000-0000-4000-8000-0000000000bb';
const key = (kind: 'device' | 'mac' | 'client', value: string) => unifiEndpointKey({ hostKey: 'host:1', controllerSiteId: 'default', kind, value });
const SWITCH = key('device', 'dev-switch-1'), AP1 = key('device', 'dev-ap-1'), AP2 = key('device', 'dev-ap-2');
const at = new Date('2026-09-25T12:00:00.000Z');
const relationshipPhysicalDetailSchema = relationshipDetailResponseSchema.shape.physical;

const device = (id: string, over: Partial<NormalizedUnifiDeviceRow> = {}): NormalizedUnifiDeviceRow => ({
  rowKey: id, deviceId: id, mac: null, name: id, model: null, ipAddress: null, state: 'ONLINE', endpointKey: key('device', id), inventoryDeviceId: null, ...over,
});
const client = (id: string, clientType: NormalizedUnifiClientRow['clientType'], uplink: string | null, over: Partial<NormalizedUnifiClientRow> = {}): NormalizedUnifiClientRow => ({
  rowKey: id, clientId: id, mac: null, clientType, uplinkDeviceId: uplink, name: id, ipAddress: null, uplinkPortIndex: null, ssid: null, vlan: null, signalDbm: null,
  endpointKey: key('client', id), uplinkEndpointKey: uplink ? key('device', uplink) : null, inventoryDeviceId: null, ...over,
});
const detail = (id: string, uplink: string | null, port: number | null): NormalizedUnifiDeviceDetailRow => ({
  rowKey: id, deviceId: id, uplinkDeviceId: uplink, uplinkPortIndex: port, ports: [], endpointKey: key('device', id), uplinkEndpointKey: uplink ? key('device', uplink) : null,
});

type State = { nodes: Map<string, NodePublication>; relationships: Map<string, RelationshipPublication> };
let tag = 1;
function input(kind: 'unifi_device_list' | 'unifi_client_list' | 'unifi_device_details', rows: unknown[], state: State, context: { endpointDevices?: Record<string, string> } = {}): TopologyProjectionInput {
  const contextKey = `${COLLECTOR}:default`;
  const section = { kind, contextKey, contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: rows.length, rows };
  const source = { ...FIXTURE_SCOPE, id: `0e000000-0000-4000-8000-00000000000${['unifi_device_list', 'unifi_client_list', 'unifi_device_details'].indexOf(kind) + 1}`,
    producerId: COLLECTOR, producerKind: 'unifi', producerEpoch: 'epoch-1', protocol: kind, contextKey, addressFamily: 'any' } as unknown as CollectionSource;
  const run = { ...FIXTURE_SCOPE, id: `0e000000-0000-4000-8000-0000000001${String(tag++).padStart(2, '0')}`, sourceId: source.id, sequence: '1', contentDigest: 'a'.repeat(64),
    effectiveAt: at, observedAt: at, receivedAt: at, expectedIntervalSeconds: 300 } as unknown as CollectionRun;
  return { scope: FIXTURE_SCOPE, source, run, snapshot: { section } as never, originNodeId: null, nodes: [...state.nodes.values()], relationships: [...state.relationships.values()], interfaces: [],
    physical: { authorityKey: contextKey, subjectNodeId: null, deviceMacs: [], deviceNodes: { [INVENTORY_DEVICE]: INVENTORY_NODE }, unifiEndpointDevices: context.endpointDevices ?? {} } };
}
function apply(state: State, delta: TopologyProjectionDelta) {
  for (const n of delta.nodes) state.nodes.set(n.id, n);
  for (const r of delta.relationships) state.relationships.set(r.id, r);
}
const fresh = (): State => ({ nodes: new Map(), relationships: new Map() });
const nodeByKey = (state: State, sourceKey: string) => [...state.nodes.values()].find(n => n.identityMaterial.sourceKey === sourceKey);

describe('UniFi projection (M2 Task 6b, D16)', () => {
  it('device list: one scoped controller endpoint node per device; an inventory-bound device reuses its inventory node', () => {
    const state = fresh();
    const delta = projectTopology(input('unifi_device_list', [device('dev-switch-1'), device('dev-ap-1', { inventoryDeviceId: INVENTORY_DEVICE })], state));
    apply(state, delta);
    expect(delta.relationships).toEqual([]);
    expect(delta.observations).toEqual([]);
    expect(nodeByKey(state, SWITCH)).toMatchObject({ kind: 'endpoint', attributes: { label: 'dev-switch-1' } });
    // Bound through the agent-reported NIC MAC only: no second node for it.
    expect(nodeByKey(state, AP1)).toBeUndefined();
    expect(state.nodes.size).toBe(1);
  });

  it('client list: wired with port, wireless, vpn/teleport and unknown are attachments with a typed association, never physical links', () => {
    const state = fresh();
    const rows = [
      client('c-wired', 'WIRED', 'dev-switch-1', { uplinkPortIndex: 4, vlan: 10 }), client('c-wired-noport', 'WIRED', 'dev-switch-1'),
      client('c-wifi', 'WIRELESS', 'dev-ap-1'), client('c-vpn', 'VPN', 'dev-switch-1'), client('c-tele', 'TELEPORT', 'dev-switch-1'),
      client('c-unknown', 'unknown', 'dev-switch-1'), client('c-orphan', 'VPN', null),
    ];
    const delta = projectTopology(input('unifi_client_list', rows, state, { endpointDevices: { [AP1]: INVENTORY_DEVICE } }));
    apply(state, delta);
    const byRow = new Map(delta.observations.map(o => [String(o.attributes.rowKey), delta.relationships.find(r => r.id === o.relationshipId)!]));
    expect(delta.relationships.every(r => r.kind === 'attachment' && r.attributes?.method === 'unifi' && r.evidenceClass === 'observed')).toBe(true);
    expect(byRow.get('c-wired')).toMatchObject({ directness: 'unknown', logicalContext: { controllerSiteId: 'default', vlanIds: [10] },
      attributes: { physical: { association: 'wired', uplinkPortIndex: 4, endpointKey: key('client', 'c-wired'), uplinkEndpointKey: SWITCH } } });
    expect(byRow.get('c-wired-noport')!.attributes!.physical).not.toHaveProperty('uplinkPortIndex');
    expect(byRow.get('c-wifi')).toMatchObject({ directness: 'direct', attributes: { physical: { association: 'wireless' } } });
    expect(byRow.get('c-vpn')!.attributes!.physical!.association).toBe('vpn');
    expect(byRow.get('c-tele')!.attributes!.physical!.association).toBe('teleport');
    expect(byRow.get('c-unknown')!.attributes!.physical!.association).toBe('unknown');
    // No uplink: nothing to attach to; no orphan client node is minted.
    expect(byRow.has('c-orphan')).toBe(false);
    expect(nodeByKey(state, key('client', 'c-orphan'))).toBeUndefined();
    // Uplink bound to inventory (via the device list) targets the inventory node.
    expect(byRow.get('c-wifi')!.sourceNodeId).toBe(INVENTORY_NODE);
    expect(byRow.get('c-wired')!.sourceNodeId).toBe(nodeByKey(state, SWITCH)!.id);
    expect(byRow.get('c-wired')!.targetNodeId).toBe(nodeByKey(state, key('client', 'c-wired'))!.id);
    expect(() => validatePublicationInput(FIXTURE_SCOPE, { buildFence: '1', inputRevision: '1', nodes: [...state.nodes.values()], relationships: [...state.relationships.values()], bindings: [] })).not.toThrow();
  });

  it('projected associations reach relationship detail with a truthful, schema-valid label (teleport is a tunnel; unknown claims nothing)', () => {
    const state = fresh();
    const clients = projectTopology(input('unifi_client_list', [
      client('c-wired', 'WIRED', 'dev-switch-1', { uplinkPortIndex: 4 }), client('c-wifi', 'WIRELESS', 'dev-ap-1'), client('c-vpn', 'VPN', 'dev-switch-1'),
      client('c-tele', 'TELEPORT', 'dev-switch-1'), client('c-unknown', 'unknown', 'dev-switch-1'),
    ], state));
    const uplinks = projectTopology(input('unifi_device_details', [detail('dev-ap-1', 'dev-switch-1', 7)], state));
    const shown = new Map<string, string | null>();
    for (const delta of [clients, uplinks]) {
      for (const o of delta.observations) {
        const r = delta.relationships.find(x => x.id === o.relationshipId)!;
        // Exactly what graph.ts reads: r.attributes->>'method' and r.attributes->'physical'.
        const row: DetailRow = { id: r.id, kind: r.kind, sourceNodeId: r.sourceNodeId, targetNodeId: r.targetNodeId, sourceInterfaceId: null, targetInterfaceId: null,
          directness: r.directness ?? null, confidence: r.confidence ?? 'low', evidenceClass: r.evidenceClass as DetailRow['evidenceClass'], lifecycle: 'active', lastSupportedAt: null,
          supportCount: '1', legacy: false, method: String(r.attributes!.method), physical: r.attributes!.physical as DetailRow['physical'] };
        const physical = physicalDetail(row);
        expect(relationshipPhysicalDetailSchema.safeParse(physical).success).toBe(true);
        shown.set(String(o.attributes.rowKey), physical!.association);
      }
    }
    expect(Object.fromEntries(shown)).toEqual({ 'c-wired': 'wired', 'c-wifi': 'wireless', 'c-vpn': 'vpn', 'c-tele': 'vpn', 'c-unknown': null, 'dev-ap-1': 'uplink' });
  });

  it('a roaming client maps its row to a NEW relationship; the old one keeps no support from this row', () => {
    const state = fresh();
    const first = projectTopology(input('unifi_client_list', [client('c-roam', 'WIRELESS', 'dev-ap-1')], state));
    apply(state, first);
    const second = projectTopology(input('unifi_client_list', [client('c-roam', 'WIRELESS', 'dev-ap-2')], state));
    const [a] = first.relationships, [b] = second.relationships;
    expect(a!.id).not.toBe(b!.id);
    expect(b!.sourceNodeId).toBe(nodeByKey({ ...state, nodes: new Map([...state.nodes, ...second.nodes.map(n => [n.id, n] as const)]) }, AP2)!.id);
    expect(second.observations.map(o => [o.attributes.rowKey, o.relationshipId])).toEqual([['c-roam', b!.id]]);
    expect(second.support.map(s => s.relationshipId)).toEqual([b!.id]);
  });

  it('device details: an uplink without a resolvable local port is an attachment with the uplink port as material', () => {
    const state = fresh();
    const delta = projectTopology(input('unifi_device_details', [detail('dev-ap-1', 'dev-switch-1', 7), detail('dev-switch-1', null, null)], state));
    expect(delta.relationships).toHaveLength(1);
    expect(delta.relationships[0]).toMatchObject({ kind: 'attachment', attributes: { method: 'unifi', physical: { association: 'uplink', uplinkPortIndex: 7 } } });
    expect(delta.relationships.some(r => r.kind === 'physical_link')).toBe(false);
  });

  it('endpoint bindings come only from retained device/client list rows, and an ambiguous endpoint binds nothing', () => {
    const baseline = (kind: string, rows: unknown[]) => ({ section: { kind, rows } });
    const map = unifiEndpointDevicesOf([
      baseline('unifi_device_list', [device('dev-ap-1', { inventoryDeviceId: INVENTORY_DEVICE }), device('dev-switch-1')]),
      baseline('unifi_client_list', [client('c-1', 'WIRED', 'dev-switch-1', { inventoryDeviceId: '0d000000-0000-4000-8000-0000000000cc' })]),
      baseline('unifi_statistics', [{ rowKey: 'x', endpointKey: SWITCH, inventoryDeviceId: INVENTORY_DEVICE }]),
      baseline('unifi_device_list', [device('dev-ap-2', { inventoryDeviceId: INVENTORY_DEVICE }), { ...device('dev-ap-1'), inventoryDeviceId: '0d000000-0000-4000-8000-0000000000dd' }]),
    ]);
    expect(map).toEqual({ [key('client', 'c-1')]: '0d000000-0000-4000-8000-0000000000cc', [AP2]: INVENTORY_DEVICE });
  });
});

describe('UniFi controller ports (M3 Task 4 prerequisite)', () => {
  const withPorts = (id: string, ports: NormalizedUnifiDeviceDetailRow['ports']): NormalizedUnifiDeviceDetailRow => ({ ...detail(id, null, null), ports });
  const port = (portIndex: number, over: Partial<NormalizedUnifiDeviceDetailRow['ports'][number]> = {}) =>
    ({ portIndex, name: `Port ${portIndex}`, linkUp: true, speedMbps: 1000, poeMode: null, ...over });

  it('publishes one canonical interface per reported port, keyed by a controller port key', () => {
    const state = fresh();
    const delta = projectTopology(input('unifi_device_details', [withPorts('dev-switch-1', [port(1), port(2)])], state));
    apply(state, delta);
    const owner = nodeByKey(state, SWITCH)!;
    expect(delta.interfaces).toHaveLength(2);
    expect(delta.interfaces.map(i => [i.ownerNodeId, i.interfaceKey, i.epoch, i.osIndex, i.name])).toEqual([
      [owner.id, 'unifi-port:1', 'gen:1', '1', 'Port 1'], [owner.id, 'unifi-port:2', 'gen:1', '2', 'Port 2'],
    ]);
    expect(delta.interfaces[0]!.controllerPortKey).toBe(unifiControllerPortKey(SWITCH, 1));
    expect(unifiControllerPortKey(SWITCH, 1).startsWith(unifiControllerPortNamespace('host:1', 'default'))).toBe(true);
    expect(unifiControllerPortKey(SWITCH, 1).length).toBeLessThanOrEqual(255);
  });

  it('keeps the generation across reports and label changes (port index is the identity)', () => {
    const state = fresh();
    const first = projectTopology(input('unifi_device_details', [withPorts('dev-switch-1', [port(1)])], state));
    apply(state, first);
    const again = projectTopology({ ...input('unifi_device_details', [withPorts('dev-switch-1', [port(1, { name: 'Uplink' })])], state), interfaces: first.interfaces });
    expect(again.interfaces).toHaveLength(1);
    expect(again.interfaces[0]).toMatchObject({ id: first.interfaces[0]!.id, epoch: 'gen:1', name: 'Uplink', retiredAt: null });
  });
});
