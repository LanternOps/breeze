import { describe, expect, it, vi } from 'vitest';
import { graphRelationshipSchema } from '@breeze/shared';
import { policyHealthContribution, policyHealthContributor, type PolicyHealthRow } from './policyHealth';
import { aggregateTopologySubjectHealth, TOPOLOGY_HEALTH_CONTRIBUTORS } from './subjectHealth';

const POLICY = '11111111-1111-4111-8111-111111111111';
const REL = '33333333-3333-4333-8333-333333333333';
const NODE = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const ORIGIN = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-02T12:00:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function row(over: Partial<PolicyHealthRow> = {}): PolicyHealthRow {
  return {
    policyId: POLICY, armed: true, blockedReason: null, nodeId: null, relationshipId: REL, intervalSeconds: 60,
    runId: RUN, current: true, contextKey: 'ctx-a', family: 'ipv4', state: 'completed', assessment: 'failed_check', coverage: 'complete',
    reasons: ['icmp_no_response'], finishedAt: ago(30), deadline: ago(10), originNodeId: ORIGIN, ...over,
  };
}
const valid = (health: unknown) => expect(graphRelationshipSchema.shape.health.safeParse(health).success, JSON.stringify(health)).toBe(true);

describe('policy health contributor (M3-D10 run/policy branch)', () => {
  it('is registered once as the policy source next to monitor and interface health', () => {
    expect(TOPOLOGY_HEALTH_CONTRIBUTORS.map((c) => c.source)).toEqual(['monitor', 'interface', 'policy']);
    expect(TOPOLOGY_HEALTH_CONTRIBUTORS).toContain(policyHealthContributor);
  });

  it('projects a fresh completed scheduled run, fresh for max(3 x cadence, 60 s) and citing the run', () => {
    const c = policyHealthContribution(row(), NOW)!;
    expect(c).toMatchObject({
      subject: { kind: 'relationship', id: REL }, source: 'policy', status: 'failed_check', coverage: 'monitored', freshness: 'fresh',
      reasons: ['icmp_no_response'], resultId: RUN, originNodeId: ORIGIN, contextKey: `policy:${POLICY}:ctx-a:ipv4`,
    });
    expect(c.freshUntil).toBe(new Date(ago(30).getTime() + 180_000).toISOString());
    // A 30 s cadence still gets the 60 s floor.
    expect(policyHealthContribution(row({ intervalSeconds: 10 }), NOW)!.freshUntil).toBe(new Date(ago(30).getTime() + 60_000).toISOString());
    valid(aggregateTopologySubjectHealth('relationship', [c], NOW).health);
  });

  it('expires by cadence without a write, and never lets an old result decide status', () => {
    const c = policyHealthContribution(row({ finishedAt: ago(600), deadline: ago(590) }), NOW)!;
    expect(c).toMatchObject({ freshness: 'stale', freshUntil: null });
    expect(c.reasons).toContain('policy_result_stale');
    const health = aggregateTopologySubjectHealth('relationship', [c], NOW).health;
    valid(health);
  });

  it('treats a failed, expired or late run as missing evidence, not a measured failure', () => {
    for (const over of [{ state: 'failed', assessment: 'unknown' }, { state: 'expired', assessment: 'unknown' }, { finishedAt: ago(5), deadline: ago(10) }] as const) {
      const c = policyHealthContribution(row(over), NOW)!;
      expect(c).toMatchObject({ status: 'unknown', freshness: 'stale', coverage: 'unavailable', freshUntil: null });
      expect(c.reasons).toContain('policy_run_not_completed');
      valid(aggregateTopologySubjectHealth('relationship', [c], NOW).health);
    }
  });

  it('makes a disarmed policy unmonitored immediately and a re-armed policy without a current-revision result pending', () => {
    // The subject is the one its scheduled runs measured; the old result itself is fenced out.
    const disarmed = policyHealthContribution(row({ armed: false, blockedReason: 'actor_revoked', current: false }), NOW)!;
    expect(disarmed).toMatchObject({ subject: { kind: 'relationship', id: REL }, status: 'unknown', coverage: 'unmonitored', freshness: 'unknown', reasons: ['actor_revoked'], resultId: null });
    expect(policyHealthContribution(row({ armed: false, blockedReason: 'Not A Code!' }), NOW)!.reasons).toEqual(['policy_disabled']);
    const pending = policyHealthContribution(row({ current: false }), NOW)!;
    expect(pending).toMatchObject({ status: 'unknown', coverage: 'unavailable', freshness: 'unknown', reasons: ['policy_result_pending'], resultId: null });
    valid(aggregateTopologySubjectHealth('relationship', [disarmed, pending], NOW).health);
    // A run with no graph subject contributes nothing to the graph.
    expect(policyHealthContribution(row({ relationshipId: null, nodeId: null }), NOW)).toBeNull();
    expect(policyHealthContribution(row({ relationshipId: null, nodeId: NODE }), NOW)!.subject).toEqual({ kind: 'node', id: NODE });
  });

  it('reads only the requested subjects in the caller scope, and skips the read when there are none', async () => {
    const execute = vi.fn(async () => [row()]);
    const ctx = { scope: { orgId: 'o', siteId: 's' } } as never;
    expect(await policyHealthContributor.read({ executor: { execute } as never, ctx, subjects: [], now: NOW, exposure: { interfaceHealth: false } })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const out = await policyHealthContributor.read({ executor: { execute } as never, ctx, subjects: [{ kind: 'relationship', id: REL }], now: NOW, exposure: { interfaceHealth: false } });
    expect(out).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
