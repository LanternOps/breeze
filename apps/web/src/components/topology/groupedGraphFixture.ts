import type { GraphResponse } from '@breeze/shared';
import { SITE } from './topologyFixtures';

export type GroupedFixtureNetwork = { prefix: string; declaration: 'declared' | 'undeclared' | null; members: number; sources?: ('discovery_profile' | 'network_baseline')[] };
const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixtureNode = (id: string, label: string, address: string): GraphResponse['nodes'][number] => ({ id, kind: 'endpoint', role: null, label, bindings: [], lifecycle: 'active', freshness: 'fresh',
  evidence: { classes: [], methods: [], count: '0', lastObservedAt: null },
  health: { status: 'unknown', coverage: 'unmonitored', scope: 'node', originNodeId: null, resultId: null, freshness: 'unknown', reasons: [{ code: 'x', message: 'x' }] }, availableActions: [],
  inventory: { source: 'device', name: label, addresses: [address], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } });

/**
 * A grouped overview: one IPv4 lan network card per entry (gateway `<net>.1`, `members` endpoints), each with a gateway card
 * joined by a routes_via edge. `declaration: null` omits the declaration (non-lan / IPv6 shape); a declared entry with
 * `members: 0` is the memberless `declared_site_network` card. `unidentified` adds an unidentified group of that many endpoints.
 */
export const groupedGraphFixture = (networks: GroupedFixtureNetwork[], options: { unidentified?: number } = {}): GraphResponse => {
  let next = 1;
  const nodes: GraphResponse['nodes'] = [], presentationNodes: GraphResponse['presentation']['nodes'] = [], edges: GraphResponse['presentation']['edges'] = [];
  const base = { view: 'overview' as const, frontierToken: 't', authority: false as const };
  networks.forEach((network, index) => {
    const stem = network.prefix.split('/')[0]!.split('.').slice(0, 3).join('.');
    const gatewayAddress = `${stem}.1`;
    const members = Array.from({ length: network.members }, (_, i) => {
      const memberId = fixtureId(next++);
      nodes.push(fixtureNode(memberId, `HOST-${index}-${i}`, `${stem}.${10 + i}`));
      return { nodeId: memberId, placement: 'observed' as const, primary: true, stale: false };
    });
    const netId = `presentation:overview:scope:net-${index}`, gatewayId = `presentation:overview:scope:gw-${index}`;
    presentationNodes.push({ ...base, id: netId, role: 'network_group', label: network.prefix, memberCount: members.length, group: {
      kind: 'network', basis: members.length || network.declaration !== 'declared' ? 'inferred_site_prefix' : 'declared_site_network', networkClass: 'lan', prefix: network.prefix, address: null,
      gatewayAddresses: members.length ? [gatewayAddress] : [], conflict: false, observerCount: members.length, members, canonicalNodeIds: [],
      ...(network.declaration ? { declaration: { state: network.declaration, sources: network.sources ?? (network.declaration === 'declared' ? ['discovery_profile' as const] : []) } } : {}) } });
    if (!members.length) return;
    presentationNodes.push({ ...base, id: gatewayId, role: 'gateway_group', label: `Reported gateway ${gatewayAddress}`, memberCount: members.length, group: {
      kind: 'gateway', basis: 'reported_gateway', networkClass: null, prefix: null, address: gatewayAddress, gatewayAddresses: [], conflict: false, observerCount: members.length, members: [], canonicalNodeIds: [] } });
    edges.push({ id: `presentation:overview:edge:rv-${index}`, sourceNodeId: netId, targetNodeId: gatewayId, relationshipKind: null, presentationOnly: true, authority: false, meaning: 'aggregate', role: 'routes_via',
      contributingRelationshipIds: [fixtureId(900 + index)], memberCount: members.length, frontierToken: 't' });
  });
  if (options.unidentified) {
    const members = Array.from({ length: options.unidentified }, (_, i) => {
      const memberId = fixtureId(next++);
      nodes.push(fixtureNode(memberId, `UNKNOWN-${i}`, `192.168.77.${10 + i}`));
      return { nodeId: memberId, placement: 'observed' as const, primary: true, stale: false };
    });
    presentationNodes.push({ ...base, id: 'presentation:overview:scope:unidentified', role: 'unidentified_group', label: 'Network not identified', memberCount: members.length, group: {
      kind: 'unidentified', basis: 'unidentified', networkClass: null, prefix: null, address: null, gatewayAddresses: [], conflict: false, observerCount: 0, members, canonicalNodeIds: [] } });
  }
  return { schemaVersion: 1, siteId: SITE, view: 'overview', asOf: '2026-10-02T00:00:00.000Z', revisions: { graph: '1', health: '1', layout: '0' }, nodes, relationships: [],
    presentation: { nodes: presentationNodes, edges }, layout: { algorithm: 'none', version: 0, positions: [] },
    counts: { totalNodes: nodes.length, totalRelationships: 0, visibleNodes: nodes.length, visibleRelationships: 0, omittedNodes: 0, omittedRelationships: 0 },
    coverage: { state: 'complete', reasons: [] }, frontier: [], permissions: { canEdit: true, canDiagnose: false, canConfigureMonitoring: false, canMoveDevices: false } };
};
