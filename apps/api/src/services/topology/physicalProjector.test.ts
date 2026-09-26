import { describe, expect, it } from 'vitest';
import { buildPhysicalRelationship, projectPhysicalTopology, selectFdbParent, selectFdbParents, type FdbCandidate } from './physicalProjector';
import { applyFdbSelection } from './physicalPublication';
import { projectTopology } from './projectors';
import { validatePublicationInput } from './publish';
import { physicalLinkKey } from './physicalIdentity';
import {
  applyFixtureDelta, CLIENT, CLIENT_MAC, FIXTURE_SCOPE, fixtureState, physicalFixture, physicalRows as r, physicalSnapshotInput, portMac, SWITCH,
  type FixtureState, type PhysicalFixtureName,
} from './physicalFixtures';
import type { TopologyProjectionDelta } from './reconciliationTypes';
import type { RelationshipPublication } from './publish';

/** Fold every snapshot of a fixture through the registered projector. */
function fold(name: PhysicalFixtureName) {
  const fixture = physicalFixture(name);
  const deltas: TopologyProjectionDelta[] = [];
  for (const input of fixture.inputs) { const delta = projectTopology(input(fixture.state)); deltas.push(delta); applyFixtureDelta(fixture.state, delta); }
  const support = deltas.flatMap(d => d.support);
  const observations = deltas.flatMap(d => d.observations);
  return { state: fixture.state, deltas, support, observations, relationships: [...fixture.state.relationships.values()] };
}
const links = (s: { relationships: RelationshipPublication[] }) => s.relationships.filter(r => r.kind === 'physical_link');
const validate = (state: FixtureState) => validatePublicationInput(FIXTURE_SCOPE, { buildFence: '1', inputRevision: '1', nodes: [...state.nodes.values()], relationships: [...state.relationships.values()], bindings: [] });

describe('projectPhysicalTopology (D15.1)', () => {
  it('keeps parallel cables distinct and merges reciprocal LLDP+CDP evidence into one link per cable', () => {
    const result = fold('reciprocal-parallel');
    const found = links(result);
    expect(found).toHaveLength(2);
    expect(new Set(found.map(l => l.canonicalKey)).size).toBe(2);
    for (const link of found) {
      // Four independent sources: A-lldp, A-cdp, B-lldp, B-cdp.
      expect(new Set(result.support.filter(s => s.relationshipId === link.id).map(s => s.sourceId)).size).toBe(4);
      expect(link).toMatchObject({ evidenceClass: 'observed', confidence: 'high', attributes: { physical: { resolution: 'resolved' } } });
    }
    const a1b1 = found.find(l => l.identityMaterial.sourceKey === physicalLinkKey({ nodeId: SWITCH.A, interfaceId: l.sourceInterfaceId! }, { nodeId: SWITCH.B, interfaceId: l.targetInterfaceId! }));
    expect(a1b1).toBeDefined();
    expect(() => validate(result.state)).not.toThrow();
  });

  it('keeps an unresolved neighbour as a candidate attachment on a scoped unbound chassis node', () => {
    const result = fold('reciprocal-parallel');
    const candidates = result.relationships.filter(r => r.kind === 'attachment');
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate).toMatchObject({ sourceNodeId: SWITCH.A, evidenceClass: 'observed', confidence: 'low', directness: 'unknown', attributes: { method: 'lldp', physical: {
      resolution: 'unresolved', subjectAuthority: 'snmp:192.0.2.1', remoteChassis: { subtype: 'mac_address', value: '02:00:00:00:ee:01' }, remotePort: { subtype: 'interface_name', value: 'Gi0/9' },
      localPort: { namespace: 'lldp_local', value: '3', resolvedInterfaceKey: 'name:Gi0/3' } } } });
    const unbound = result.state.nodes.get(candidate.targetNodeId)!;
    expect(unbound.identityMaterial.sourceKey).toBe('lldp-chassis:mac_address:02%3A00%3A00%3A00%3Aee%3A01');
  });

  it('maps every eligible positive row to exactly one relationship through rowKey', () => {
    const result = fold('reciprocal-parallel');
    for (const delta of result.deltas) {
      const byRow = new Map<string, Set<string>>();
      for (const o of delta.observations) byRow.set(String(o.attributes.rowKey), (byRow.get(String(o.attributes.rowKey)) ?? new Set()).add(o.relationshipId!));
      for (const ids of byRow.values()) expect(ids.size).toBe(1);
    }
    expect(result.observations.map(o => o.attributes.rowKey).sort()).toEqual(['1.1', '1.1', '1.1', '1.1', '2.1', '2.1', '2.1', '2.1', '3.1'].sort());
  });

  it('keeps LAG members and a switching cycle as individual links (no dedupe, no pruning)', () => {
    const result = fold('lag-cycle');
    expect(links(result)).toHaveLength(4);
    const pairs = links(result).map(l => [l.sourceNodeId, l.targetNodeId].sort().join('-')).sort();
    expect(pairs).toEqual([[SWITCH.A, SWITCH.B].sort().join('-'), [SWITCH.A, SWITCH.B].sort().join('-'), [SWITCH.A, SWITCH.C].sort().join('-'), [SWITCH.B, SWITCH.C].sort().join('-')].sort());
  });

  it('refuses sysName and management-address matches (never merges by name or IP)', () => {
    const state = fixtureState(['A', 'B'], [1]);
    const row = r.lldp(1, { chassisMac: '02:00:00:00:ee:02' }, 1, 1, { remoteSysName: 'switch-B', remoteAddresses: ['192.0.2.2'] });
    const delta = projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [row] }, state));
    expect(delta.relationships.map(x => x.kind)).toEqual(['attachment']);
    expect(delta.relationships[0]!.targetNodeId).not.toBe(SWITCH.B);
    expect(delta.nodes).toHaveLength(1);
    expect(delta.nodes[0]!.attributes).toEqual({ label: 'switch-B' });
  });

  it('drops self-adjacency rows instead of minting a loop', () => {
    const state = fixtureState(['A'], [1, 2]);
    const delta = projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, 'A', 2)] }, state));
    expect(delta.relationships).toEqual([]);
  });

  it('projects FDB rows as inferred attachments with unknown directness, even on infrastructure ports, and never from shared ports', () => {
    const result = fold('ambiguous-fdb');
    const fdb = result.relationships.filter(x => x.attributes?.method === 'fdb');
    expect(fdb).toHaveLength(4);
    for (const row of fdb) expect(row).toMatchObject({ kind: 'attachment', evidenceClass: 'inferred', directness: 'unknown', confidence: 'low' });
    // B1 is the measured uplink; its FDB row is still retained as a candidate.
    expect(fdb.some(x => x.sourceNodeId === SWITCH.B && x.sourceInterfaceId && result.state.interfaces.get(x.sourceInterfaceId)?.name === 'Gi0/1')).toBe(true);
    // The known client MAC resolves to its agent-bound node; the other stays an unbound MAC endpoint.
    expect(fdb.filter(x => x.targetNodeId === CLIENT)).toHaveLength(2);
    const shared = projectTopology(physicalSnapshotInput('A', { kind: 'fdb', rows: [{ rowType: 'shared_port', rowKey: 'shared_port|default|9', bridgeContext: 'default', bridgePort: 9, ifIndex: 9, sizeBucket: '17-64' }],
      metadata: { ineligibleRowCount: 0, sharedPortCount: 1, collapsedRowCount: 20 } }, result.state));
    expect(shared.relationships).toEqual([]);
    expect(() => validate(result.state)).not.toThrow();
  });

  it('resolves a candidate once the remote identity exists (identity enrichment)', () => {
    const fixture = physicalFixture('identity-enrichment');
    const first = projectTopology(fixture.inputs[0]!(fixture.state));
    applyFixtureDelta(fixture.state, first);
    expect(first.relationships.map(x => x.kind)).toEqual(['attachment']);
    const second = projectTopology(fixture.inputs[1]!(fixture.state));
    applyFixtureDelta(fixture.state, second);
    expect(second.interfaces.map(i => [i.ownerNodeId, i.interfaceKey, i.epoch, i.physAddress])).toEqual([[SWITCH.B, 'name:Gi0/1', 'gen:1', portMac('B', 1)]]);
    // Re-projecting the unchanged A report now yields a measured link.
    const again = projectTopology(fixture.inputs[0]!(fixture.state));
    expect(again.relationships.map(x => x.kind)).toEqual(['physical_link']);
  });

  it('allocates a new interface generation on ifIndex reuse, and the link does not follow it', () => {
    const state = fixtureState(['A', 'B'], [1]);
    const link1 = projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, 'B', 1)] }, state));
    applyFixtureDelta(state, link1);
    const reuse = projectTopology(physicalSnapshotInput('B', { kind: 'snmp_interfaces', rows: [r.iface('B', 1, '02:00:00:00:99:01')] }, state));
    applyFixtureDelta(state, reuse);
    expect(reuse.interfaces.map(i => [i.epoch, !!i.retiredAt])).toEqual(expect.arrayContaining([['gen:1', true], ['gen:2', false]]));
    const link2 = projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, { chassisMac: '02:00:00:00:99:01' }, 1)] }, state));
    expect(link2.relationships[0]!.kind).toBe('physical_link');
    expect(link2.relationships[0]!.id).not.toBe(link1.relationships[0]!.id);
    expect(link2.relationships[0]!.targetInterfaceId ?? link2.relationships[0]!.sourceInterfaceId).not.toBe(link1.relationships[0]!.targetInterfaceId);
  });

  it('is deterministic: reordered identical facts produce identical keys and deltas', () => {
    const rows = [r.lldp(1, 'B', 1), r.lldp(2, 'B', 2), r.lldp(3, { chassisMac: '02:00:00:00:ee:01' }, 9)];
    const one = projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows }, fixtureState(['A', 'B'], [1, 2, 3])));
    const two = projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [...rows].reverse() }, fixtureState(['A', 'B'], [1, 2, 3])));
    const shape = (d: TopologyProjectionDelta) => d.relationships.map(x => [x.id, x.canonicalKey]).sort();
    expect(shape(two)).toEqual(shape(one));
    expect(two.nodes.map(n => n.id).sort()).toEqual(one.nodes.map(n => n.id).sort());
  });

  it('attributes an unresolved target to a scoped unbound target node, never the collector', () => {
    const state = fixtureState(['A', 'B'], [1]);
    const delta = projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [r.lldp(1, 'B', 1)] }, state, { subjectResolved: false }));
    expect(delta.relationships.map(x => x.kind)).toEqual(['attachment']);
    const subject = delta.nodes.find(n => n.id === delta.relationships[0]!.sourceNodeId)!;
    expect(subject.identityMaterial.sourceKey).toBe('physical-target:snmp%3A192.0.2.1');
  });

  it('projects nothing for complete-empty and failed sections, and nothing yet for UniFi families', () => {
    const state = fixtureState(['A'], [1]);
    expect(projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [] }, state)).relationships).toEqual([]);
    expect(projectTopology(physicalSnapshotInput('A', { kind: 'lldp', rows: [], outcome: 'failed' }, state)).relationships).toEqual([]);
    const unifi = physicalSnapshotInput('A', { kind: 'unifi_client_list', rows: [] }, state);
    expect(projectPhysicalTopology(unifi)).toEqual({ nodes: [], relationships: [], bindings: [], interfaces: [], observations: [], support: [] });
  });
});

describe('FDB parent selection (D15.3)', () => {
  const c = (id: string, portKey: string, extra: Partial<FdbCandidate> = {}): FdbCandidate => ({ relationshipId: id, clientNodeId: CLIENT, upstreamNodeId: portKey.split(':')[0]!, portKey, vlanIds: [10], active: true, infrastructure: false, ...extra });
  it('selects a single eligible candidate at medium confidence', () => {
    expect(selectFdbParent([c('r1', 'A:5')])).toEqual({ selected: expect.objectContaining({ relationshipId: 'r1' }), alternatives: [], reason: null });
  });
  it('records competing candidates as alternatives and selects none', () => {
    const result = selectFdbParent([c('r1', 'A:5'), c('r2', 'B:7')]);
    expect(result.selected).toBeNull();
    expect(result.alternatives.map(x => x.relationshipId).sort()).toEqual(['r1', 'r2']);
    expect(result.reason).toBe('competing_candidates');
  });
  it('excludes infrastructure ports and inactive evidence before competing', () => {
    expect(selectFdbParent([c('r1', 'A:6'), c('r2', 'B:1', { infrastructure: true })]).selected?.relationshipId).toBe('r1');
    expect(selectFdbParent([c('r1', 'A:6'), c('r2', 'B:7', { active: false })]).selected?.relationshipId).toBe('r1');
    expect(selectFdbParent([c('r2', 'B:1', { infrastructure: true })])).toEqual({ selected: null, alternatives: [], reason: 'no_eligible_candidate' });
  });
  it('dedupes the same normalized port reported by several reporters', () => {
    expect(selectFdbParent([c('r1', 'A:5'), c('r1b', 'A:5')]).selected).not.toBeNull();
  });
  it('treats disjoint complete VLAN contexts as independent memberships', () => {
    const decisions = selectFdbParents([c('r1', 'A:5', { vlanIds: [10] }), c('r2', 'B:7', { vlanIds: [20] })]);
    expect(decisions.get('r1')).toMatchObject({ selection: 'selected', confidence: 'medium' });
    expect(decisions.get('r2')).toMatchObject({ selection: 'selected', confidence: 'medium' });
    const unknown = selectFdbParents([c('r1', 'A:5', { vlanIds: null }), c('r2', 'B:7', { vlanIds: [20] })]);
    expect(unknown.get('r1')).toMatchObject({ selection: 'competing', confidence: 'low', alternatives: ['r2'] });
  });
  // #5998 review: a client learned on 66 ports produced 65 alternatives per
  // row, over the publication schema's bound of 64, and rejected the WHOLE
  // publication. Alternatives are bounded deterministically with a count.
  it('bounds competing alternatives to 64 (lowest ids) and counts the rest', () => {
    const ids = Array.from({ length: 66 }, (_, i) => `r${String(i).padStart(2, '0')}`);
    const decisions = selectFdbParents(ids.map((id, i) => c(id, `U${i}:5`)));
    for (const id of ids) {
      const d = decisions.get(id)!;
      expect(d.selection).toBe('competing');
      expect(d.alternatives).toEqual(ids.filter(o => o !== id).slice(0, 64));
      expect(d.alternativesOmitted).toBe(1);
    }
    expect(selectFdbParents([c('r1', 'A:5'), c('r2', 'B:7')]).get('r1')).toMatchObject({ alternatives: ['r2'], alternativesOmitted: 0 });
  });
  it('publishes 66 competing FDB candidates for one client without rejecting the publication', () => {
    const uuid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const rows = Array.from({ length: 66 }, (_, i) => buildPhysicalRelationship(FIXTURE_SCOPE, {
      method: 'fdb', subjectAuthority: `snmp:198.51.100.${i + 1}`, localPort: { namespace: 'if_index', value: '5', resolvedInterfaceKey: null },
      remoteChassis: { subtype: 'mac_address', value: CLIENT_MAC }, bridgeContext: 'default', fdbId: 1, vlanIds: [10],
    }, { kind: 'candidate', sourceNodeId: uuid(i + 1), sourceInterfaceId: null, targetNodeId: CLIENT, unboundSourceKey: 'unused', resolved: false }, CLIENT, undefined, new Date('2026-09-15T12:00:00Z')));
    const relationships = new Map(rows.map(row => [row.id, row]));
    const changed = applyFdbSelection({ clients: new Set([CLIENT]), relationships, current: id => relationships.get(id)! });
    expect(changed).toHaveLength(66);
    for (const row of changed) {
      expect(row.attributes!.physical!.alternativeRelationshipIds).toHaveLength(64);
      expect(row.attributes!.physical!.alternativeRelationshipsOmitted).toBe(1);
    }
    expect(() => validatePublicationInput(FIXTURE_SCOPE, { buildFence: '1', inputRevision: '1', nodes: [], relationships: changed, bindings: [] })).not.toThrow();
  });
  it('marks infrastructure and inactive candidates explicitly, clearing any old selection', () => {
    const decisions = selectFdbParents([c('r1', 'A:5', { infrastructure: true }), c('r2', 'B:7', { active: false })]);
    expect(decisions.get('r1')).toMatchObject({ selection: 'excluded', confidence: 'low' });
    expect(decisions.get('r2')).toMatchObject({ selection: 'none', confidence: 'low' });
    void CLIENT_MAC;
  });
});
