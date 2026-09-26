import { describe, expect, it } from 'vitest';
import { topologyImpactResponseSchema } from '@breeze/shared';
import { analyzeTopologyImpact, type ImpactEvidence, type ImpactGraph, type ImpactRelationship } from './impact';

/**
 * Pure impact analysis (M3 Task 10). Fixtures use stable UUIDs, explicit
 * freshness and context; no fixture measures a failure it does not state.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(9000);
const NOW = Date.parse('2026-09-26T10:00:00.000Z');
const FRESH = new Date(NOW + 60_000).toISOString();
const STALE = new Date(NOW - 60_000).toISOString();
const A = id(1), B = id(2), C = id(3), D = id(4), E = id(5), F = id(6), G2 = id(7), HIDDEN = id(8), NET = id(9);

type NodeSpec = [string, string, string | null];
function graph(nodes: NodeSpec[], relationships: Partial<ImpactRelationship>[], extra: Partial<ImpactGraph> = {}): ImpactGraph {
  return {
    siteId: SITE, graphRevision: '7', healthRevision: '3', truncated: false, physicalExposed: true,
    nodes: nodes.map(([nodeId, kind, role]) => ({ id: nodeId, kind, role, label: `node-${nodeId.slice(-2)}` })),
    relationships: relationships.map((r, index) => ({
      id: id(100 + index), kind: 'physical_link', sourceNodeId: A, targetNodeId: B, directness: 'direct', confidence: 'high',
      evidenceClass: 'observed', method: 'lldp', association: null, freshUntil: FRESH, ...r,
    }) as ImpactRelationship),
    ...extra,
  };
}
const evidence = (health: ImpactEvidence['health'] = []): ImpactEvidence => ({
  window: { minutes: 5, from: new Date(NOW - 300_000).toISOString(), to: new Date(NOW).toISOString() }, health, routedPaths: [],
});
const run = (g: ImpactGraph, effect: { kind: 'node' | 'relationship'; id: string }, ev = evidence(), budgetMs = 5000, clock?: () => number) => {
  const result = analyzeTopologyImpact(g, effect, ev, budgetMs, { now: new Date(NOW), ...(clock ? { clock } : {}) });
  expect(topologyImpactResponseSchema.safeParse(result).success, JSON.stringify(topologyImpactResponseSchema.safeParse(result).error?.issues)).toBe(true);
  return result;
};
const entry = (result: ReturnType<typeof run>, nodeId: string) => result.potentiallyAffected.find((x) => x.id === nodeId);

// Diamond: gateway A → B → D and A → C → D.
const diamond = () => graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [C, 'endpoint', 'switch'], [D, 'endpoint', 'switch']], [
  { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: A, targetNodeId: C },
  { id: id(103), sourceNodeId: B, targetNodeId: D }, { id: id(104), sourceNodeId: C, targetNodeId: D },
]);
const edgeAB = id(101);

describe('analyzeTopologyImpact', () => {
  it('reports an unverified alternative rather than declaring downstream loss', () => {
    const result = run(diamond(), { kind: 'relationship', id: edgeAB });
    expect(entry(result, D)?.reasons).toContain('alternative_path_unverified');
    expect(result.measuredFailures.some((x) => x.id === D)).toBe(false);
    expect(result.alternatives.find((a) => a.nodeId === D)).toMatchObject({ state: 'unverified', relationshipIds: [id(102), id(104)] });
    expect(result.assumptions).toContain('forwarding_state_unverified');
    // B is still reachable through C and D: an alternative exists, availability unverified.
    expect(entry(result, B)?.reasons).toContain('alternative_path_unverified');
    expect(entry(result, B)?.evidenceIds).toEqual([edgeAB]);
    expect(result.subject).toEqual({ kind: 'relationship', id: edgeAB, measured: false });
    expect(result.assumptions).toContain('subject_failure_hypothetical');
    expect(result.coverage).toBe('complete');
  });

  it('says no known alternative for a leaf behind the failed uplink, and cites the path', () => {
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [E, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: B, targetNodeId: E },
    ]);
    const result = run(g, { kind: 'relationship', id: id(101) });
    expect(entry(result, E)).toMatchObject({ basis: 'dependency_path', hops: 2, evidenceIds: [id(101), id(102)] });
    expect(entry(result, E)!.reasons).toContain('no_known_alternative_path');
    expect(entry(result, A)).toBeUndefined();
  });

  it('terminates on cycles and is deterministic', () => {
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [C, 'endpoint', 'switch'], [D, 'endpoint', 'switch']], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: B, targetNodeId: C },
      { id: id(103), sourceNodeId: C, targetNodeId: D }, { id: id(104), sourceNodeId: D, targetNodeId: B },
    ]);
    const first = run(g, { kind: 'relationship', id: id(101) });
    const reversed = run({ ...g, relationships: [...g.relationships].reverse(), nodes: [...g.nodes].reverse() }, { kind: 'relationship', id: id(101) });
    expect(first.potentiallyAffected.map((x) => x.id)).toEqual([B, C, D]);
    expect({ ...reversed, asOf: 0 }).toEqual({ ...first, asOf: 0 });
    expect(first.potentiallyAffected.every((x) => x.reasons.includes('no_known_alternative_path'))).toBe(true);
  });

  it('treats a parallel cable or LAG member as an unverified alternative, never as loss', () => {
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch']], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: B, targetNodeId: A },
    ]);
    const result = run(g, { kind: 'relationship', id: id(101) });
    expect(entry(result, B)!.reasons).toEqual(expect.arrayContaining(['alternative_path_unverified', 'parallel_link_present']));
  });

  it('labels stale, manual, inferred, FDB, unmanaged and VPN path segments', () => {
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [C, 'endpoint', null], [D, 'endpoint', null], [E, 'endpoint', null], [F, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B },
      { id: id(102), sourceNodeId: B, targetNodeId: C, kind: 'attachment', method: 'fdb', evidenceClass: 'inferred', confidence: 'low', directness: 'unknown' },
      { id: id(103), sourceNodeId: B, targetNodeId: D, evidenceClass: 'manual', method: null, freshUntil: null },
      { id: id(104), sourceNodeId: B, targetNodeId: E, freshUntil: STALE, directness: 'via_unmanaged' },
      { id: id(105), sourceNodeId: B, targetNodeId: F, method: 'unifi', association: 'vpn' },
    ]);
    const result = run(g, { kind: 'relationship', id: id(101) });
    expect(entry(result, C)!.reasons).toEqual(expect.arrayContaining(['path_via_attachment', 'path_via_fdb_inference', 'path_via_inferred_relationship', 'path_low_confidence', 'path_directness_unknown']));
    expect(entry(result, D)!.reasons).toContain('path_via_manual_relationship');
    expect(entry(result, D)!.reasons).not.toContain('path_evidence_stale');
    expect(entry(result, E)!.reasons).toEqual(expect.arrayContaining(['path_evidence_stale', 'path_via_unmanaged_segment']));
    expect(entry(result, F)!.reasons).toContain('path_via_vpn');
  });

  it('with multiple gateways, losing one gateway leaves an unverified alternative', () => {
    const g = graph([[A, 'gateway', null], [G2, 'gateway', null], [B, 'endpoint', 'switch'], [E, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: G2, targetNodeId: B }, { id: id(103), sourceNodeId: B, targetNodeId: E },
    ]);
    const result = run(g, { kind: 'node', id: A });
    expect(result.assumptions).toContain('multiple_upstream_anchors');
    expect(entry(result, B)!.reasons).toContain('alternative_path_unverified');
    expect(entry(result, E)!.reasons).toContain('alternative_path_unverified');
    expect(entry(result, A)).toBeUndefined();
  });

  it('losing the only gateway leaves every dependent without a known alternative', () => {
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [E, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: B, targetNodeId: E },
    ]);
    const result = run(g, { kind: 'node', id: A });
    expect(result.potentiallyAffected.map((x) => [x.id, x.hops, x.evidenceIds])).toEqual([[B, 1, [id(101)]], [E, 2, [id(101), id(102)]]]);
    expect(result.potentiallyAffected.every((x) => x.reasons.includes('no_known_alternative_path'))).toBe(true);
    expect(result.coverage).toBe('complete');
  });

  it('treats a network membership as a possible group, never cable dependence', () => {
    const g = graph([[A, 'gateway', null], [NET, 'network', null], [B, 'endpoint', null], [C, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), kind: 'network_member', sourceNodeId: B, targetNodeId: NET, method: null, evidenceClass: 'inferred' },
      { id: id(103), kind: 'network_member', sourceNodeId: C, targetNodeId: NET, method: null, evidenceClass: 'inferred' },
    ]);
    const group = run(g, { kind: 'node', id: NET });
    expect(entry(group, B)).toMatchObject({ basis: 'group_membership', reasons: ['group_member_possible'] });
    expect(entry(group, C)).toMatchObject({ basis: 'group_membership' });
    const membership = run(g, { kind: 'relationship', id: id(102) });
    expect(membership.potentiallyAffected).toEqual([]);
    expect(membership.assumptions).toContain('membership_not_dependency');
    // Membership never carries a dependency path: failing the uplink does not reach C through the network.
    expect(entry(run(g, { kind: 'relationship', id: id(101) }), C)).toBeUndefined();
  });

  it('never routes through, counts or cites a node the reader cannot see', () => {
    // HIDDEN is filtered by the loader (not in nodes); its edges must not open a path.
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [E, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: B, targetNodeId: E },
      { id: id(103), sourceNodeId: A, targetNodeId: HIDDEN }, { id: id(104), sourceNodeId: HIDDEN, targetNodeId: E },
    ]);
    const result = run(g, { kind: 'relationship', id: id(101) });
    expect(entry(result, E)!.reasons).toContain('no_known_alternative_path');
    expect(JSON.stringify(result)).not.toContain(HIDDEN);
    expect(JSON.stringify(result)).not.toContain(id(103));
    expect(result.counts).toMatchObject({ nodes: 3, relationships: 2 });
  });

  it('marks deadline truncation visibly partial', () => {
    let t = 0;
    const result = run(diamond(), { kind: 'relationship', id: edgeAB }, evidence(), 5, () => (t += 10));
    expect(result.coverage).toBe('partial');
    expect(result.reasons).toContain('traversal_deadline');
  });

  it('marks loader truncation and node/relationship caps partial', () => {
    const result = run({ ...diamond(), truncated: true }, { kind: 'relationship', id: edgeAB });
    expect(result).toMatchObject({ coverage: 'partial' });
    expect(result.reasons).toContain('traversal_limit');
  });

  it('separates fresh measured failures from possible dependencies and keeps stale failures out', () => {
    const ev = evidence([
      { subject: { kind: 'relationship', id: edgeAB }, status: 'failed_check', freshness: 'fresh', evidenceId: `interface:${id(501)}`, evidenceKind: 'interface_measurement', contextKey: 'interface' },
      { subject: { kind: 'node', id: C }, status: 'failed_check', freshness: 'stale', evidenceId: id(502), evidenceKind: 'monitor_result', contextKey: 'monitor:x' },
    ]);
    const result = run(diamond(), { kind: 'relationship', id: edgeAB }, ev);
    expect(result.subject.measured).toBe(true);
    expect(result.measuredFailures).toEqual([{ kind: 'relationship', id: edgeAB, status: 'failed_check', evidenceIds: [`interface:${id(501)}`], reasons: [] }]);
    expect(result.reasons).toContain('failure_evidence_stale');
    expect(result.evidence).toEqual(expect.arrayContaining([{ id: `interface:${id(501)}`, kind: 'interface_measurement' }, { id: edgeAB, kind: 'relationship' }]));
    expect(result.causeSuggestion).toMatchObject({ state: 'not_suggested', reasons: ['no_corroborating_failures'] });
  });

  it('presents a success from another origin as a location-specific possibility, not discarded', () => {
    const ev = evidence([
      { subject: { kind: 'node', id: B }, status: 'failed_check', freshness: 'fresh', evidenceId: id(601), evidenceKind: 'diagnostic_run', contextKey: 'origin:1' },
      { subject: { kind: 'node', id: B }, status: 'healthy', freshness: 'fresh', evidenceId: id(602), evidenceKind: 'diagnostic_run', contextKey: 'origin:2' },
      { subject: { kind: 'node', id: D }, status: 'healthy', freshness: 'fresh', evidenceId: id(603), evidenceKind: 'monitor_result', contextKey: 'monitor:y' },
    ]);
    const result = run(diamond(), { kind: 'node', id: B }, ev);
    expect(result.measuredFailures[0]).toMatchObject({ id: B, reasons: ['location_specific_possible'] });
    expect(result.measuredFailures[0]!.evidenceIds).toEqual([id(601), id(602)]);
    expect(entry(result, D)!.reasons).toContain('contradicting_success_observed');
  });

  it('suggests a possible cause only with fresh corroborating dependent failures', () => {
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [E, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: B, targetNodeId: E },
    ]);
    const ev = evidence([
      { subject: { kind: 'node', id: B }, status: 'failed_check', freshness: 'fresh', evidenceId: id(701), evidenceKind: 'monitor_result', contextKey: 'm' },
      { subject: { kind: 'node', id: E }, status: 'failed_check', freshness: 'fresh', evidenceId: id(702), evidenceKind: 'monitor_result', contextKey: 'm' },
    ]);
    const result = run(g, { kind: 'node', id: B }, ev);
    expect(result.causeSuggestion).toEqual({ state: 'possible', corroboratingIds: [E], reasons: ['corroborated_by_dependent_failures', 'context_compatibility_unverified'] });
    expect(entry(result, E)!.reasons).toContain('failure_measured');
    // Centrality alone (no measured failure on the subject) never suggests a cause.
    const unmeasured = run(g, { kind: 'node', id: B }, evidence([ev.health[1]!]));
    expect(unmeasured.causeSuggestion).toMatchObject({ state: 'not_suggested', reasons: ['subject_failure_unmeasured'] });
  });

  it('ignores evidence for a subject that is no longer in this graph (moved or withdrawn)', () => {
    const ev = evidence([{ subject: { kind: 'node', id: HIDDEN }, status: 'failed_check', freshness: 'fresh', evidenceId: id(801), evidenceKind: 'monitor_result', contextKey: 'm' }]);
    const result = run(diamond(), { kind: 'relationship', id: edgeAB }, ev);
    expect(result.measuredFailures).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(id(801));
    expect(result.reasons).toContain('evidence_outside_graph_ignored');
  });

  it('refuses to invent a direction when no upstream anchor is known', () => {
    const g = graph([[B, 'endpoint', 'switch'], [E, 'endpoint', null]], [{ id: id(101), sourceNodeId: B, targetNodeId: E }]);
    const result = run(g, { kind: 'relationship', id: id(101) });
    expect(result.potentiallyAffected).toEqual([]);
    expect(result.coverage).toBe('partial');
    expect(result.reasons).toContain('upstream_unknown');
    expect(result.assumptions).toContain('no_upstream_anchor');
  });

  it('flags an alternative that transits a non-infrastructure endpoint', () => {
    // D is a dual-homed host: the only alternative to B goes through it.
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], [C, 'endpoint', 'switch'], [D, 'endpoint', null]], [
      { id: id(101), sourceNodeId: A, targetNodeId: B }, { id: id(102), sourceNodeId: A, targetNodeId: C },
      { id: id(103), sourceNodeId: B, targetNodeId: D }, { id: id(104), sourceNodeId: C, targetNodeId: D },
    ]);
    const result = run(g, { kind: 'relationship', id: id(101) });
    expect(result.alternatives.find((a) => a.nodeId === B)!.reasons).toContain('alternative_via_endpoint_transit');
  });

  it('bounds the result list and says so', () => {
    const leaves = Array.from({ length: 520 }, (_, i) => id(2000 + i));
    const g = graph([[A, 'gateway', null], [B, 'endpoint', 'switch'], ...leaves.map((leaf): NodeSpec => [leaf, 'endpoint', null])], [
      { id: id(101), sourceNodeId: A, targetNodeId: B },
      ...leaves.map((leaf, i) => ({ id: id(5000 + i), sourceNodeId: B, targetNodeId: leaf })),
    ]);
    const result = run(g, { kind: 'relationship', id: id(101) });
    expect(result.potentiallyAffected).toHaveLength(500);
    expect(result.counts).toMatchObject({ potentiallyAffected: 521, omittedPotentiallyAffected: 21 });
    expect(result.coverage).toBe('partial');
    expect(result.reasons).toContain('result_limit');
  });
});
