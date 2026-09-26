import { describe, expect, it } from 'vitest';
import type { TopologyDiagnosticPlan, TopologyDiagnosticStep, TopologyTraceHop } from '@breeze/shared';
import { topologyDiagnosticStepSchema } from '@breeze/shared';
import { buildTopologyTraceViews, topologyTraceStepViolation } from './tracerouteResults';

const ids = {
  device: '50000000-0000-4000-8000-000000000001',
  destination: '50000000-0000-4000-8000-000000000002',
  route: '50000000-0000-4000-8000-000000000003',
  trace: '50000000-0000-4000-8000-000000000004',
  source: '50000000-0000-4000-8000-000000000005',
  iface: '50000000-0000-4000-8000-000000000006',
};

function plan(overrides: { maxHops?: number; probesPerHop?: number } = {}): TopologyDiagnosticPlan {
  return {
    recipeId: 'trace_route',
    origin: { deviceId: ids.device, agentId: 'agent-1', contextKey: 'default', interfaceId: ids.iface, sourceId: ids.source },
    destinations: [{ id: ids.destination, target: { kind: 'observed_gateway', address: '192.0.2.9', zone: null, interfaceId: ids.iface, evidenceId: ids.source } }],
    steps: [
      { id: ids.route, method: 'route_lookup', destinationId: ids.destination, required: true },
      { id: ids.trace, method: 'trace', destinationId: ids.destination, required: true, maxHops: overrides.maxHops ?? 16, probesPerHop: overrides.probesPerHop ?? 2, hopTimeoutMs: 1000 },
    ],
  } as unknown as TopologyDiagnosticPlan;
}

const hop = (ttl: number, attempt: number, extra: Partial<TopologyTraceHop> = {}): TopologyTraceHop => ({
  ttl, attempt, address: `192.0.2.${ttl}`, rttMs: 1.25, outcome: 'reply', attributionQuality: 'observed', ...extra,
});
const gap = (ttl: number, attempt: number): TopologyTraceHop => ({ ttl, attempt, address: null, rttMs: null, outcome: 'timeout', attributionQuality: 'unknown' });

function traceStep(input: {
  state?: TopologyDiagnosticStep['state'];
  hops?: TopologyTraceHop[];
  reached?: boolean;
  maxHops?: number;
  probesPerHop?: number;
  hopsOmitted?: number;
  truncated?: boolean;
  resolvedIp?: string | null;
  routeChanged?: boolean;
}): TopologyDiagnosticStep {
  return topologyDiagnosticStepSchema.parse({
    id: ids.trace,
    state: input.state ?? 'succeeded',
    reason: input.state && input.state !== 'succeeded' ? 'trace_destination_not_reached' : null,
    attribution: {
      originDeviceId: ids.device, originAgentId: 'agent-1', requestedMethod: 'trace', actualMethod: 'trace', destinationId: ids.destination,
      resolvedIp: input.resolvedIp === undefined ? '192.0.2.9' : input.resolvedIp, family: 'ipv4', port: null, interfaceId: ids.iface, localAddress: '192.0.2.200',
      contextKey: 'default', tableKey: null, nextHop: '192.0.2.1', proxyUsed: false, quality: input.routeChanged ? 'requested_unverified' : 'observed',
      routeChanged: input.routeChanged ?? false, evidenceRefs: [],
    },
    startedAt: null, finishedAt: null, receivedAt: null, truncated: input.truncated ?? false,
    details: { trace: { protocol: 'icmp_echo', destinationReached: input.reached ?? true, maxHops: input.maxHops ?? 16, probesPerHop: input.probesPerHop ?? 2, hopsOmitted: input.hopsOmitted ?? 0, hops: input.hops ?? [hop(1, 1), hop(2, 1, { address: '192.0.2.9' })] } },
  });
}

describe('topologyTraceStepViolation', () => {
  it('accepts a trace bound to its planned bounds and destination', () => {
    expect(topologyTraceStepViolation(plan(), traceStep({}))).toBeNull();
  });

  it.each([
    ['declares more hops than planned', traceStep({ maxHops: 30 }), 'trace_bounds_mismatch'],
    ['declares other probe counts than planned', traceStep({ probesPerHop: 1 }), 'trace_bounds_mismatch'],
    ['claims success without confirmation', traceStep({ reached: false }), 'trace_confirmation_mismatch'],
    ['claims confirmation while not succeeded', traceStep({ state: 'failed_check', reached: true }), 'trace_confirmation_mismatch'],
    ['confirms a responder that is not the destination', traceStep({ hops: [hop(1, 1), hop(2, 1, { address: '198.51.100.7' })] }), 'trace_confirmation_mismatch'],
    ['omits hops without marking truncation', traceStep({ hopsOmitted: 3 }), 'trace_truncation_unmarked'],
  ])('%s', (_name, step, expected) => {
    expect(topologyTraceStepViolation(plan(), step)).toBe(expected);
  });

  it('refuses hops beyond the plan even when self-consistent', () => {
    const step = traceStep({ maxHops: 30, hops: [hop(20, 1, { address: '192.0.2.9' })] });
    expect(topologyTraceStepViolation(plan({ maxHops: 16 }), step)).toBe('trace_bounds_mismatch');
    const probes = traceStep({ probesPerHop: 2, hops: [hop(1, 2, { address: '192.0.2.9' })] });
    expect(topologyTraceStepViolation(plan({ probesPerHop: 1 }), probes)).toBe('trace_bounds_mismatch');
  });

  it('refuses trace output on a step that was not planned as a trace', () => {
    const step = { ...traceStep({}), id: ids.route };
    expect(topologyTraceStepViolation(plan(), step)).toBe('trace_output_unplanned');
  });

  it('allows an unsupported or cancelled trace to carry no hop evidence at all', () => {
    const bare = { ...traceStep({ state: 'unsupported' }), details: {} };
    expect(topologyTraceStepViolation(plan(), bare)).toBeNull();
  });
});

describe('buildTopologyTraceViews', () => {
  it('is an observed routed path, not a topology relationship path', () => {
    const [view] = buildTopologyTraceViews(plan(), [traceStep({})]);
    expect(view).toMatchObject({
      kind: 'observed_routed_path',
      stepId: ids.trace,
      requestedMethod: 'trace',
      actualMethod: 'trace',
      protocol: 'icmp_echo',
      origin: { deviceId: ids.device, agentId: 'agent-1', contextKey: 'default', interfaceId: ids.iface, localAddress: '192.0.2.200', sourceId: ids.source },
      destination: { destinationId: ids.destination, address: '192.0.2.9', family: 'ipv4' },
      destinationReached: true,
      truncated: false,
      hopsOmitted: 0,
    });
  });

  it('keeps timeout gaps and ECMP alternatives per TTL without inventing responders', () => {
    const [view] = buildTopologyTraceViews(plan(), [traceStep({
      reached: false, state: 'failed_check',
      hops: [hop(1, 1), hop(1, 2, { address: '198.51.100.1', rttMs: 2 }), gap(2, 1), gap(2, 2), hop(3, 1), hop(3, 2, { rttMs: 3 })],
    })]);
    expect(view!.hops).toEqual([
      { ttl: 1, responders: [{ address: '192.0.2.1', attempts: [1], rttMs: [1.25], outcome: 'reply', attributionQuality: 'observed' }, { address: '198.51.100.1', attempts: [2], rttMs: [2], outcome: 'reply', attributionQuality: 'observed' }], gaps: [], alternatives: true },
      { ttl: 2, responders: [], gaps: [{ attempt: 1, outcome: 'timeout' }, { attempt: 2, outcome: 'timeout' }], alternatives: false },
      { ttl: 3, responders: [{ address: '192.0.2.3', attempts: [1, 2], rttMs: [1.25, 3], outcome: 'reply', attributionQuality: 'observed' }], gaps: [], alternatives: false },
    ]);
    expect(view!.destinationReached).toBe(false);
  });

  it('surfaces truncation and a route switch explicitly', () => {
    const [view] = buildTopologyTraceViews(plan(), [traceStep({ hopsOmitted: 4, truncated: true, routeChanged: true })]);
    expect(view).toMatchObject({ truncated: true, hopsOmitted: 4, routeChanged: true, attributionQuality: 'requested_unverified' });
  });

  it('shows a planned trace with no result as not measured rather than dropping it', () => {
    const [view] = buildTopologyTraceViews(plan(), []);
    expect(view).toMatchObject({ stepId: ids.trace, state: null, hops: [], destinationReached: false, actualMethod: null });
  });
});
