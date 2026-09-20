import type { GraphNode, GraphResponse, Position, TopologyScope } from '@breeze/shared';

export const TOPOLOGY_FIXTURE_IDS = {
  orgA: '10000000-0000-4000-8000-000000000001',
  orgB: '10000000-0000-4000-8000-000000000002',
  siteA: '20000000-0000-4000-8000-000000000001',
  siteB: '20000000-0000-4000-8000-000000000002',
  nodeA: '30000000-0000-4000-8000-000000000001',
  nodeB: '30000000-0000-4000-8000-000000000002',
  bindingA: '40000000-0000-4000-8000-000000000001',
  deviceA: '50000000-0000-4000-8000-000000000001',
  healthResultA: '60000000-0000-4000-8000-000000000001',
} as const;

export const TOPOLOGY_FIXTURE_ADDRESS = {
  line1: '100 Reused Address',
  city: 'Example City',
  region: 'CO',
  postalCode: '80000',
  country: 'US',
} as const;

/** Deliberately share address values while retaining independent tenant identities. */
export const TOPOLOGY_FIXTURE_SITES = [
  {
    id: TOPOLOGY_FIXTURE_IDS.siteA,
    orgId: TOPOLOGY_FIXTURE_IDS.orgA,
    name: 'Topology fixture site A',
    address: { ...TOPOLOGY_FIXTURE_ADDRESS },
  },
  {
    id: TOPOLOGY_FIXTURE_IDS.siteB,
    orgId: TOPOLOGY_FIXTURE_IDS.orgB,
    name: 'Topology fixture site B',
    address: { ...TOPOLOGY_FIXTURE_ADDRESS },
  },
] as const;

export function buildTopologyScope(overrides: Partial<TopologyScope> = {}): TopologyScope {
  return {
    orgId: TOPOLOGY_FIXTURE_IDS.orgA,
    siteId: TOPOLOGY_FIXTURE_IDS.siteA,
    ...overrides,
  };
}

export function buildTopologyPosition(overrides: Partial<Position> = {}): Position {
  return {
    nodeId: TOPOLOGY_FIXTURE_IDS.nodeA,
    x: 0,
    y: 0,
    pinned: false,
    source: 'auto',
    rowRevision: '1',
    ...overrides,
  };
}

export function buildTopologyGraphNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: TOPOLOGY_FIXTURE_IDS.nodeA,
    kind: 'endpoint',
    role: 'workstation',
    label: 'Topology fixture endpoint',
    bindings: [{
      id: TOPOLOGY_FIXTURE_IDS.bindingA,
      type: 'device',
      referenceId: TOPOLOGY_FIXTURE_IDS.deviceA,
    }],
    lifecycle: 'active',
    freshness: 'fresh',
    evidence: {
      classes: ['observed'],
      methods: ['os_interface'],
      count: '1',
      lastObservedAt: '2026-09-15T12:00:00.000Z',
    },
    health: {
      status: 'unknown',
      coverage: 'unmonitored',
      scope: 'node',
      originNodeId: TOPOLOGY_FIXTURE_IDS.nodeA,
      resultId: TOPOLOGY_FIXTURE_IDS.healthResultA,
      reasons: [{
        code: 'not_evaluated',
        message: 'No health result has been evaluated for this fixture',
      }],
      freshness: 'unknown',
    },
    availableActions: [],
    ...overrides,
  };
}

export function buildTopologyGraphResponse(overrides: Partial<GraphResponse> = {}): GraphResponse {
  const node = buildTopologyGraphNode();
  return {
    schemaVersion: 1,
    siteId: TOPOLOGY_FIXTURE_IDS.siteA,
    view: 'overview',
    asOf: '2026-09-15T12:00:00.000Z',
    revisions: { graph: '1', health: '1', layout: '1' },
    nodes: [node],
    relationships: [],
    presentation: { nodes: [], edges: [] },
    layout: { algorithm: 'fixture', version: 1, positions: [buildTopologyPosition()] },
    counts: {
      totalNodes: 1,
      totalRelationships: 0,
      visibleNodes: 1,
      visibleRelationships: 0,
      omittedNodes: 0,
      omittedRelationships: 0,
    },
    coverage: { state: 'complete', reasons: [] },
    frontier: [],
    permissions: { canEdit: false, canDiagnose: false, canConfigureMonitoring: false },
    ...overrides,
  };
}
