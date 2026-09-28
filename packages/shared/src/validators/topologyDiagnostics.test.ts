import { describe, expect, it } from 'vitest';
import { diagnosticPlanFixture, TOPOLOGY_FIXTURE_IDS as ids } from '../testing/topologyFixtures';
import { createTopologyDiagnosticSchema, topologyDiagnosticCommandSchema, topologyDiagnosticPlanSchema, topologyDiagnosticResultSchema, topologyDiagnosticStepSchema, topologyHealthSummarySchema, topologyTraceHopSchema, TOPOLOGY_TRACE_LIMITS } from './topologyDiagnostics';
import { topologyPolicyDefinitionSchema } from './topologyConfiguration';
const request = { recipeId: 'gateway_basic', recipeVersion: 1, subject: { kind: 'node', id: ids.node }, graphRevision: '1' };
describe('topology diagnostics', () => {
  it.each(['gateway_basic', 'dns_basic', 'internet_basic', 'target_connectivity', 'trace_route'])('accepts bounded recipe %s', recipeId => expect(createTopologyDiagnosticSchema.safeParse({ ...request, recipeId }).success).toBe(true));
  it.each([{ steps: [{ type: 'shell', command: 'anything' }] }, { orgId: ids.org }, { url: 'https://example.test' }, { recipeVersion: 2 }, { subject: { kind: 'node', id: 'presentation:unknown' } }, { family: 'both' }, { recipeId: 'shell_trace' }, { trace: { maxHops: 16, probesPerHop: 1 } }])('rejects request authority injection %j', patch => expect(createTopologyDiagnosticSchema.safeParse({ ...request, ...patch }).success).toBe(false));
  it('round trips a bound normalized plan', () => expect(topologyDiagnosticPlanSchema.parse(diagnosticPlanFixture())).toEqual(diagnosticPlanFixture()));
  it.each(['cross-site', 'deadline', 'steps', 'destination', 'duplicate', 'packet-count', 'epoch'])('rejects invalid plan %s', kind => {
    const p = diagnosticPlanFixture();
    if (kind === 'cross-site') p.origin.siteId = ids.org;
    if (kind === 'deadline') p.deadline = '2026-09-15T13:00:00Z';
    if (kind === 'steps') p.steps = Array(13).fill(p.steps[0]);
    if (kind === 'destination') p.steps[0]!.destinationId = ids.node;
    if (kind === 'duplicate') p.destinations.push(p.destinations[0]!);
    if (kind === 'packet-count') Object.assign(p.steps[0]!, { packetCount: 6 });
    if (kind === 'epoch') p.origin.interfaceEpoch = null;
    expect(topologyDiagnosticPlanSchema.safeParse(p).success).toBe(false);
  });
  it('pins command digest and absolute expiry', () => {
    const plan = diagnosticPlanFixture(); const cmd = { type: 'network_diagnostic', version: 1, runId: ids.node, attemptId: ids.binding, commandId: ids.step, plan, planDigest: plan.digest, expiresAt: plan.deadline };
    expect(topologyDiagnosticCommandSchema.safeParse(cmd).success).toBe(true);
    expect(topologyDiagnosticCommandSchema.safeParse({ ...cmd, planDigest: 'a'.repeat(64) }).success).toBe(false);
    expect(topologyDiagnosticCommandSchema.safeParse({ ...cmd, expiresAt: '2026-09-15T14:00:00Z' }).success).toBe(false);
  });
  it('rejects arbitrary result output and keeps health/run coverage distinct', () => {
    const result = { version: 1, runId: ids.node, attemptId: ids.binding, commandId: ids.step, planDigest: '0'.repeat(64), steps: [], truncated: false };
    expect(topologyDiagnosticResultSchema.safeParse(result).success).toBe(true);
    expect(topologyDiagnosticResultSchema.safeParse({ ...result, stdout: 'secret' }).success).toBe(false);
    expect(topologyHealthSummarySchema.safeParse({ status: 'unknown', coverage: 'unmonitored', reasons: [], evidenceRefs: [] }).success).toBe(true);
    expect(topologyHealthSummarySchema.safeParse({ status: 'healthy', coverage: 'complete', reasons: [], evidenceRefs: [] }).success).toBe(false);
  });

  describe('bounded routed trace (M3 Task 9)', () => {
    const traceRequest = { ...request, recipeId: 'trace_route', subject: { kind: 'destination', id: ids.node } };
    it('accepts trace options only for trace_route and within 30 hops / 2 probes', () => {
      expect(createTopologyDiagnosticSchema.safeParse({ ...traceRequest, trace: { maxHops: 30, probesPerHop: 2 } }).success).toBe(true);
      expect(createTopologyDiagnosticSchema.safeParse(traceRequest).success).toBe(true);
      for (const trace of [{ maxHops: 31, probesPerHop: 1 }, { maxHops: 16, probesPerHop: 3 }, { maxHops: 0, probesPerHop: 1 }, { maxHops: 16, probesPerHop: 1, command: 'tracert' }])
        expect(createTopologyDiagnosticSchema.safeParse({ ...traceRequest, trace }).success).toBe(false);
      expect(TOPOLOGY_TRACE_LIMITS).toEqual({ defaultMaxHops: 16, maxHops: 30, defaultProbesPerHop: 1, maxProbesPerHop: 2, hopTimeoutMs: 1000, executionTimeoutSeconds: 60 });
    });
    it('never lets a recurring policy schedule a trace', () => {
      const policy = { kind: 'policy', enabled: false, recipeId: 'trace_route', recipeVersion: 1, subject: 'configured_target', targetKeys: ['check'], families: ['ipv4'], origin: 'eligible_collector', intervalSeconds: 300, jitterPercent: 10, alertsEnabled: false, failureThreshold: 3, recoveryThreshold: 2 };
      expect(topologyPolicyDefinitionSchema.safeParse(policy).success).toBe(false);
      expect(topologyPolicyDefinitionSchema.safeParse({ ...policy, recipeId: 'internet_basic' }).success).toBe(true);
    });
    function tracePlan(step: Record<string, unknown> = {}, limits: Record<string, unknown> = {}) {
      const p = diagnosticPlanFixture();
      return { ...p, recipeId: 'trace_route', limits: { ...p.limits, executionTimeoutSeconds: 60, ...limits }, steps: [{ id: ids.step, method: 'trace', destinationId: ids.destination, required: true, maxHops: 16, probesPerHop: 1, hopTimeoutMs: 1000, ...step }] };
    }
    it('accepts a bounded trace step inside a trace_route plan', () => expect(topologyDiagnosticPlanSchema.safeParse(tracePlan()).success).toBe(true));
    it.each([
      ['31 hops', { maxHops: 31 }, {}], ['3 probes', { probesPerHop: 3 }, {}], ['slow hop', { hopTimeoutMs: 1001 }, {}],
      ['no destination', { destinationId: null }, {}], ['90s execution', {}, { executionTimeoutSeconds: 90 }],
    ])('rejects a trace plan with %s', (_name, step, limits) => expect(topologyDiagnosticPlanSchema.safeParse(tracePlan(step, limits)).success).toBe(false));
    it('rejects a trace step smuggled into another recipe', () => expect(topologyDiagnosticPlanSchema.safeParse({ ...tracePlan(), recipeId: 'gateway_basic' }).success).toBe(false));
    it('rejects non-trace probes inside a trace_route plan', () => {
      const p = tracePlan();
      p.steps.push({ id: ids.binding, method: 'tcp', destinationId: ids.destination, required: true, timeoutMs: 5000 } as never);
      expect(topologyDiagnosticPlanSchema.safeParse(p).success).toBe(false);
    });
    const attribution = { originDeviceId: ids.device, originAgentId: 'fixture-agent', requestedMethod: 'trace', actualMethod: 'trace', destinationId: ids.destination, resolvedIp: '192.0.2.9', family: 'ipv4', port: null, interfaceId: null, localAddress: null, contextKey: 'default', tableKey: null, nextHop: null, proxyUsed: false, quality: 'observed', routeChanged: false, evidenceRefs: [] };
    const hop = (ttl: number, attempt: number, extra: Record<string, unknown> = {}) => ({ ttl, attempt, address: `192.0.2.${ttl}`, rttMs: 1.5, outcome: 'reply', attributionQuality: 'observed', ...extra });
    const step = (hops: unknown[], trace: Record<string, unknown> = {}) => ({ id: ids.step, state: 'succeeded', reason: null, attribution, startedAt: null, finishedAt: null, receivedAt: null, truncated: false,
      details: { trace: { protocol: 'icmp_echo', destinationReached: true, maxHops: 16, probesPerHop: 1, hopsOmitted: 0, hops, ...trace } } });
    it('keeps a timeout gap as a null hop with its reason, never an invented address', () => {
      expect(topologyDiagnosticStepSchema.safeParse(step([hop(1, 1), hop(2, 1, { address: null, rttMs: null, outcome: 'timeout', attributionQuality: 'unknown' }), hop(3, 1)])).success).toBe(true);
      expect(topologyTraceHopSchema.safeParse(hop(2, 1, { outcome: 'timeout' })).success).toBe(false);
      expect(topologyTraceHopSchema.safeParse(hop(2, 1, { address: null })).success).toBe(false);
      expect(topologyTraceHopSchema.safeParse(hop(31, 1)).success).toBe(false);
      expect(topologyTraceHopSchema.safeParse(hop(3, 3)).success).toBe(false);
    });
    it('keeps ECMP alternatives at one TTL but refuses duplicate or unordered probes', () => {
      expect(topologyDiagnosticStepSchema.safeParse(step([hop(1, 1), hop(1, 2, { address: '192.0.2.77' })], { probesPerHop: 2 })).success).toBe(true);
      expect(topologyDiagnosticStepSchema.safeParse(step([hop(1, 1), hop(1, 1)])).success).toBe(false);
      expect(topologyDiagnosticStepSchema.safeParse(step([hop(2, 1), hop(1, 1)])).success).toBe(false);
    });
    it('holds 30 hops x 2 probes of IPv6 evidence inside the 8 KiB step bound only through explicit truncation', () => {
      const full = Array.from({ length: 60 }, (_, i) => hop(Math.floor(i / 2) + 1, (i % 2) + 1, { address: `2001:db8:ffff:ffff:ffff:ffff:ffff:${(i + 1).toString(16)}`, attributionQuality: 'requested_unverified', rttMs: 999.999 }));
      expect(topologyDiagnosticStepSchema.safeParse(step(full, { maxHops: 30, probesPerHop: 2 })).success).toBe(false);
      expect(topologyDiagnosticStepSchema.safeParse(step(full.slice(0, 40), { maxHops: 30, probesPerHop: 2, hopsOmitted: 20 })).success).toBe(true);
    });
    it('rejects free-form trace output', () => expect(topologyDiagnosticStepSchema.safeParse(step([hop(1, 1)], { stdout: ' 1  192.0.2.1  1.1 ms' })).success).toBe(false));
  });
});
