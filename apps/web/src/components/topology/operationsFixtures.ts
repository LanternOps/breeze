import type {
  TopologyChangePage, TopologyDiagnosticRun, TopologyImpactResponse, TopologyInterfaceHistoryResponse, TopologyLinkHealthResponse, TopologyMonitoringStatus,
} from '@breeze/shared';
import { diagnosticPlanFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { NODE, SITE } from './topologyFixtures';

/** Deterministic M3 operational fixtures for the panel tests (every one parses under its strict wire schema). */
export const OPS = {
  site: SITE, node: NODE,
  peer: '61000000-0000-4000-8000-000000000001', relationship: '61000000-0000-4000-8000-000000000002',
  port: '61000000-0000-4000-8000-000000000003', peerPort: '61000000-0000-4000-8000-000000000004',
  source: '61000000-0000-4000-8000-000000000005', oldSource: '61000000-0000-4000-8000-000000000006',
  policy: '61000000-0000-4000-8000-000000000007', arm: '61000000-0000-4000-8000-000000000008', user: '61000000-0000-4000-8000-000000000009',
  device: '61000000-0000-4000-8000-00000000000a', profile: '61000000-0000-4000-8000-00000000000b', alert: '61000000-0000-4000-8000-00000000000c',
  run: '61000000-0000-4000-8000-00000000000d', traceStep: '61000000-0000-4000-8000-00000000000e', destination: '61000000-0000-4000-8000-00000000000f',
};
const T0 = '2026-09-26T10:00:00.000Z', T1 = '2026-09-26T10:05:00.000Z', T2 = '2026-09-26T10:10:00.000Z', T3 = '2026-09-26T10:15:00.000Z';
const point = (at: string, value: number | null) => ({
  at, value, min: value, max: value, validDurationMs: value === null ? 0 : 300_000, sampleCount: value === null ? 0 : 5,
  gapDurationMs: value === null ? 300_000 : 0, reasons: value === null ? ['collection_gap'] : [],
});

/** A measured zero, a null gap, and a new interface generation (the old one is a separate, stopped series). */
export const historyFixture = (): TopologyInterfaceHistoryResponse => ({
  interfaceId: OPS.port, interfaceEpoch: 'gen:2', resolution: '5m', interval: { from: T0, to: T3, bucketSeconds: 300 },
  series: [
    { name: 'in_bps', unit: 'bits_per_second', interfaceEpoch: 'gen:1', sourceId: OPS.oldSource, sourceKind: 'snmp', producerEpoch: 'p1', coverage: 'complete',
      points: [point(T0, 2_500_000)], gaps: [], reasons: [] },
    { name: 'in_bps', unit: 'bits_per_second', interfaceEpoch: 'gen:2', sourceId: OPS.source, sourceKind: 'snmp', producerEpoch: 'p2', coverage: 'partial',
      points: [point(T1, 0), point(T2, null), point(T3, 1_000_000)], gaps: [{ from: T2, to: T3, reason: 'collection_gap' }], reasons: [] },
  ],
  epochs: [
    { interfaceEpoch: 'gen:1', sourceId: OPS.oldSource, sourceKind: 'snmp', producerEpoch: 'p1', current: false, sourceState: 'stopped', from: T0, to: T1 },
    { interfaceEpoch: 'gen:2', sourceId: OPS.source, sourceKind: 'snmp', producerEpoch: 'p2', current: true, sourceState: 'active', from: T1, to: T3 },
  ],
  coverage: 'partial', reasons: [], asOf: T3,
});

const measurement = (interfaceId: string, over: Partial<NonNullable<TopologyLinkHealthResponse['endpoints']['source']>> = {}) => ({
  interfaceId, interfaceEpoch: 'gen:2', retired: false, status: 'healthy' as const, coverage: 'monitored' as const, freshness: 'fresh' as const, reasons: [],
  adminStatus: 'up' as const, operStatus: 'up' as const, capacityBps: '1000000000', sourceId: OPS.source, sourceKind: 'snmp' as const, observedAt: T3,
  freshUntil: '2026-09-26T10:18:00.000Z', expectedIntervalSeconds: 60,
  rates: { from: T2, to: T3, values: [{ name: 'in_bps' as const, unit: 'bits_per_second' as const, value: 1_000_000, reason: null }, { name: 'in_errors_per_second' as const, unit: 'per_second' as const, value: null, reason: 'one_sided_counter' }] },
  ...over,
});
export const linkHealthFixture = (over: Partial<TopologyLinkHealthResponse> = {}): TopologyLinkHealthResponse => ({
  siteId: SITE, relationshipId: OPS.relationship, graphRevision: '3', healthRevision: '4',
  health: { status: 'healthy', coverage: 'monitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [], freshness: 'fresh' },
  freshUntil: '2026-09-26T10:18:00.000Z', interfaceEvidence: { applies: true, reason: null },
  endpoints: { source: measurement(OPS.port), target: null }, asOf: T3, ...over,
});
export const unmeasuredLinkFixture = (): TopologyLinkHealthResponse => linkHealthFixture({
  health: { status: 'unknown', coverage: 'unmonitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [{ code: 'not_measured', message: 'Not measured' }], freshness: 'unknown' },
  freshUntil: null, endpoints: { source: null, target: null },
});

export const policyDefinition = {
  kind: 'policy' as const, enabled: true, recipeId: 'gateway_basic' as const, recipeVersion: 1 as const, subject: 'reported_gateway' as const, targetKeys: [],
  families: ['ipv4' as const], origin: 'original_reporter' as const, intervalSeconds: 300, jitterPercent: 10 as const, alertsEnabled: true, failureThreshold: 3, recoveryThreshold: 2,
};
export const policyListFixture = (over: Record<string, unknown> = {}) => ({
  items: [{ id: OPS.policy, key: 'gateway', revision: '4', enabled: false, activationIntent: true, blockedReason: null, definition: policyDefinition,
    subjectNodeId: null, subjectRelationshipId: null, ...over }],
  nextCursor: null,
});
export const monitoringFixture = (over: Partial<TopologyMonitoringStatus['policies'][number]> = {}, arms: TopologyMonitoringStatus['telemetryArms'] = []): TopologyMonitoringStatus => ({
  siteId: SITE,
  policies: [{ policyId: OPS.policy, key: 'gateway', recipeId: 'gateway_basic', enabled: false, activationIntent: true, blockedReason: null, intervalSeconds: 300,
    failureThreshold: 3, recoveryThreshold: 2, nextScheduledAt: null, lastScheduledAt: null, streaks: [], ...over }],
  telemetryArms: arms,
});
export const armStateFixture = (over: Record<string, unknown> = {}) => ({
  policyId: OPS.policy, revision: '5', enabled: true, activationIntent: true, blockedReason: null, armedAt: T3, armedBy: OPS.user,
  authorityDigest: 'a'.repeat(64), contexts: [{ contextKey: 'default', family: 'ipv4' }], nextScheduledAt: '2026-09-26T10:20:00.000Z', ...over,
});
export const telemetryArmFixture = (over: Partial<TopologyMonitoringStatus['telemetryArms'][number]> = {}): TopologyMonitoringStatus['telemetryArms'][number] => ({
  id: OPS.arm, targetNodeId: NODE, collectorDeviceId: OPS.device, authorityKey: 'snmp:192.0.2.10', interfaceCount: 1, intervalSeconds: 60, state: 'armed',
  blockedReason: null, generation: '1', armedBy: OPS.user, armedAt: T3, expiresAt: '2026-10-26T10:15:00.000Z', ...over,
});

export const impactFixture = (over: Partial<TopologyImpactResponse> = {}): TopologyImpactResponse => ({
  siteId: SITE, graphRevision: '3', healthRevision: '4', subject: { kind: 'relationship', id: OPS.relationship, measured: true },
  window: { minutes: 5, from: T2, to: T3 },
  measuredFailures: [{ kind: 'relationship', id: OPS.relationship, status: 'failed_check', evidenceIds: [OPS.run], reasons: ['interface_down'] }],
  potentiallyAffected: [
    { kind: 'node', id: OPS.peer, label: 'Desk switch', basis: 'dependency_path', hops: 1, reasons: ['alternative_path_unverified'], evidenceIds: [OPS.relationship] },
    { kind: 'node', id: NODE, label: 'Printer VLAN', basis: 'group_membership', hops: 2, reasons: ['group_member_possible'], evidenceIds: [] },
  ],
  alternatives: [{ nodeId: OPS.peer, relationshipIds: [OPS.relationship], state: 'unverified', reasons: [] }],
  routedPaths: [{ runId: OPS.run, stepId: OPS.traceStep, kind: 'observed_routed_path', destinationReached: false, respondingHops: 2, gapHops: 1, truncated: false, finishedAt: T3 }],
  causeSuggestion: { state: 'not_suggested', corroboratingIds: [], reasons: ['insufficient_corroboration'] },
  assumptions: ['forwarding_state_unobserved'], coverage: 'complete', reasons: [],
  counts: { nodes: 3, relationships: 2, potentiallyAffected: 2, omittedPotentiallyAffected: 0 },
  evidence: [{ id: OPS.run, kind: 'diagnostic_run' }], asOf: T3, ...over,
});

export const changesFixture = (over: Partial<TopologyChangePage> = {}): TopologyChangePage => ({
  siteId: SITE, graphRevision: '3', window: { since: T0, until: T3 },
  changes: [
    { id: `relationship_observed:${OPS.relationship}`, at: T2, kind: 'relationship_observed', category: 'physical_link', subject: { kind: 'relationship', id: OPS.relationship },
      evidenceIds: [], detail: 'available', attributes: { relationshipKind: 'physical_link', method: 'lldp' } },
    { id: `collection_gap:${OPS.source}`, at: T1, kind: 'collection_gap', category: 'collection', subject: { kind: 'source', id: OPS.source },
      evidenceIds: [], detail: 'expired', attributes: { producerKind: 'snmp', outcome: 'failed' } },
  ],
  cursor: null, reasons: [], asOf: T3, ...over,
});

/** A completed trace_route run: TTL 1 answered, TTL 2 silent (unknown), destination not reached. */
export const traceRunFixture = (): TopologyDiagnosticRun => {
  const plan = diagnosticPlanFixture();
  return {
    id: OPS.run, attemptId: OPS.traceStep, commandId: OPS.destination, state: 'completed', assessment: 'degraded', coverage: 'partial', reasons: [],
    plan: { ...plan, recipeId: 'trace_route', destinations: [{ id: OPS.destination, target: { kind: 'observed_gateway', address: '192.0.2.1', zone: null, interfaceId: plan.origin.interfaceId!, evidenceId: OPS.source } }],
      steps: [{ id: OPS.traceStep, method: 'trace', destinationId: OPS.destination, required: true, maxHops: 16, probesPerHop: 1, hopTimeoutMs: 1000 }],
      limits: { ...plan.limits, executionTimeoutSeconds: 60 } },
    steps: [{
      id: OPS.traceStep, state: 'failed_check', reason: 'destination_not_reached', startedAt: T2, finishedAt: T3, receivedAt: T3, truncated: false,
      attribution: { originDeviceId: plan.origin.deviceId, originAgentId: plan.origin.agentId, requestedMethod: 'trace', actualMethod: 'trace', destinationId: OPS.destination,
        resolvedIp: '192.0.2.1', family: 'ipv4', port: null, interfaceId: null, localAddress: '192.0.2.50', contextKey: 'default', tableKey: null, nextHop: null, proxyUsed: null,
        quality: 'observed', routeChanged: false, evidenceRefs: [] },
      details: { trace: { protocol: 'icmp_echo', destinationReached: false, maxHops: 16, probesPerHop: 1, hopsOmitted: 0, hops: [
        { ttl: 1, attempt: 1, address: '192.0.2.254', rttMs: 1.5, outcome: 'reply', attributionQuality: 'observed' },
        { ttl: 2, attempt: 1, address: null, rttMs: null, outcome: 'timeout', attributionQuality: 'unknown' },
      ] } },
    }],
    queuedAt: plan.acceptedAt, startedAt: T2, deadline: plan.deadline, finishedAt: T3, cancelRequestedAt: null, failureReason: null,
  };
};
