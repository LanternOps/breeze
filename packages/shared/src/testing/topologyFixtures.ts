import type { NetworkContextV1 } from '../types/topologyCollection';
import type { TopologyDiagnosticPlan } from '../types/topologyDiagnostics';
export const TOPOLOGY_FIXTURE_IDS = {
  org: '10000000-0000-4000-8000-000000000001', site: '10000000-0000-4000-8000-000000000002',
  node: '10000000-0000-4000-8000-000000000003', device: '10000000-0000-4000-8000-000000000004',
  interface: '10000000-0000-4000-8000-000000000005', binding: '10000000-0000-4000-8000-000000000006',
  source: '10000000-0000-4000-8000-000000000007', snapshot: '10000000-0000-4000-8000-000000000008',
  destination: '10000000-0000-4000-8000-000000000009', step: '10000000-0000-4000-8000-000000000010',
} as const;
const ids = TOPOLOGY_FIXTURE_IDS;
/** Fresh allocation per call; documentation-only addresses and no network I/O. */
export function networkContextFixture(): Extract<NetworkContextV1, { reportKind: 'full' }> {
  return {
    version: 1, producerEpoch: 'fixture-epoch-1', snapshotId: ids.snapshot, sequence: '1', capturedAt: '2026-09-15T12:00:00Z', captureAgeAtSendMs: 0, expectedIntervalSeconds: 300, contentDigest: '6a9fae86bed2576055be3c1f08be15854e952ad301b3e426b374a6f7b0be640b', reportKind: 'full',
    capabilities: [{ name: 'interfaces', version: 1, supported: true }], contextManifest: { outcome: 'complete', contexts: [{ contextKey: 'default', families: ['ipv4'] }] },
    sections: [
      { kind: 'interfaces', contextKey: 'default', addressFamily: 'ipv4', contentDigest: '0d010463b7bb1877af468e60badf519f816cf43c0e3a76824b1b794aa4b1fc0f', outcome: 'complete', rowCount: 1, rows: [{ rowKey: 'if-1', interfaceKey: 'if-1', osIndex: 1, name: 'eth0', kind: 'ethernet', adminState: 'up', operState: 'up', mtu: 1500, addresses: [{ address: '192.0.2.10', prefixLength: 24, family: 'ipv4', zone: null, state: 'preferred', assignment: 'static' }] }] },
      { kind: 'routes', contextKey: 'default', addressFamily: 'ipv4', contentDigest: 'deae7875ca5e7a9fbaf4d2446340eeaf9ab735f221711714a6e9e79d52a8fac9', outcome: 'complete', rowCount: 1, rows: [{ rowKey: 'default-route', family: 'ipv4', destinationPrefix: '0.0.0.0/0', interfaceKey: 'if-1', tableKey: 'main', routeType: 'unicast', metric: 100, nextHops: [{ address: '192.0.2.1', zone: null, interfaceKey: 'if-1', weight: null }], osFlags: 0 }] },
      { kind: 'rules', contextKey: 'default', addressFamily: 'ipv4', contentDigest: '70536d10c124cda1ffd58f4063fbf81dc16034a42bd7435290ff45a60d40117c', outcome: 'complete', rowCount: 0, rows: [] },
      { kind: 'resolvers', contextKey: 'default', addressFamily: 'ipv4', contentDigest: '4c3f93fdf958105c746cb4feda14f78d3527b09711912ba851714ca4ad764228', outcome: 'complete', rowCount: 1, rows: [{ rowKey: 'resolver-1', address: '192.0.2.53', zone: null, interfaceKey: 'if-1', isLocalStub: false, port: 53, transport: 'udp_tcp', domains: [{ name: 'example.test', routeOnly: false }], mechanism: 'resolv_conf' }] },
      { kind: 'neighbors', contextKey: 'default', addressFamily: 'ipv4', contentDigest: 'b705db76a241d2bc0c43f9361995232d935da52c263694b14425a15091354777', outcome: 'complete', rowCount: 0, rows: [] },
    ],
  };
}
export function diagnosticPlanFixture(): TopologyDiagnosticPlan {
  return {
    version: 1, recipeId: 'gateway_basic', recipeVersion: 1, scope: { orgId: ids.org, siteId: ids.site }, subject: { kind: 'node', id: ids.node },
    origin: { deviceId: ids.device, agentId: 'fixture-agent', nodeId: ids.node, bindingId: ids.binding, siteId: ids.site, contextKey: 'default', interfaceId: ids.interface, interfaceEpoch: '1', interfaceKey: 'if-1', sourceId: ids.source, producerEpoch: 'fixture-epoch-1', sequence: '1' },
    family: 'ipv4', graphRevision: '1', settingsRevision: '1', contextRevision: '1', templateVersions: { partner: null, org: null, defaults: 1, resolver: 1 },
    destinations: [{ id: ids.destination, target: { kind: 'observed_gateway', address: '192.0.2.1', zone: null, interfaceId: ids.interface, evidenceId: ids.snapshot } }],
    steps: [{ id: ids.step, method: 'icmp', destinationId: ids.destination, required: true, packetCount: 3, timeoutMs: 2000, payloadBytes: 64 }],
    limits: { maxConcurrentSteps: 2, maxTargetAddresses: 4, maxResolvers: 2, queueTimeoutSeconds: 30, executionTimeoutSeconds: 90, lifetimeSeconds: 120 },
    acceptedAt: '2026-09-15T12:00:00Z', queueDeadline: '2026-09-15T12:00:30Z', deadline: '2026-09-15T12:02:00Z', digest: '0'.repeat(64), reasons: [],
  };
}

/** Version-pinned empty layers for configuration merge/adoption tests. */
export function configurationLayersFixture() {
  return {
    schemaVersion: 1 as const,
    resolverVersion: 1,
    defaultsVersion: 1,
    defaults: { passive: { enabled: true, intervalSeconds: 300, neighbors: true, routingRules: true }, outboundEnabled: false, targets: {}, policies: {} },
    partner: { versionId: '10000000-0000-4000-8000-000000000101', payload: { targets: {}, policies: {} } },
    organization: { versionId: '10000000-0000-4000-8000-000000000102', payload: { targets: {}, policies: {} } },
    site: { targets: {}, policies: {} },
  };
}

/** Fleet-scale fixtures (graph stress, visible projections, ingest fleet). */
export {
  TOPOLOGY_FIXTURE_SEED, buildTopologyFixture, topologyGraphFixture, topologyIngestFixture,
} from './topologyFleet';
export type {
  TopologyFixture, TopologyFixtureName, TopologyGraphFixture, TopologyIngestFixture,
  TopologyFixtureNode, TopologyFixtureEdge, TopologyFixtureAgent,
} from './topologyFleet';
