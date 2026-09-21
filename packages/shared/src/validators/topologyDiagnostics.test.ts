import { describe, expect, it } from 'vitest';
import { diagnosticPlanFixture, TOPOLOGY_FIXTURE_IDS as ids } from '../testing/topologyFixtures';
import { createTopologyDiagnosticSchema, topologyDiagnosticCommandSchema, topologyDiagnosticPlanSchema, topologyDiagnosticResultSchema, topologyHealthSummarySchema } from './topologyDiagnostics';
const request = { recipeId: 'gateway_basic', recipeVersion: 1, subject: { kind: 'node', id: ids.node }, graphRevision: '1' };
describe('topology diagnostics', () => {
  it.each(['gateway_basic', 'dns_basic', 'internet_basic', 'target_connectivity'])('accepts bounded recipe %s', recipeId => expect(createTopologyDiagnosticSchema.safeParse({ ...request, recipeId }).success).toBe(true));
  it.each([{ steps: [{ type: 'shell', command: 'anything' }] }, { orgId: ids.org }, { url: 'https://example.test' }, { recipeVersion: 2 }, { subject: { kind: 'node', id: 'presentation:unknown' } }, { family: 'both' }, { recipeId: 'trace_route' }])('rejects request authority injection %j', patch => expect(createTopologyDiagnosticSchema.safeParse({ ...request, ...patch }).success).toBe(false));
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
});
