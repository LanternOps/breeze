import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import {
  TOPOLOGY_IMPACT_LIMITS, topologyImpactQuerySchema,
  type Freshness, type HealthStatus, type TopologyDiagnosticPlan, type TopologyDiagnosticStep, type TopologyImpactResponse,
} from '@breeze/shared';
import { db } from '../../db';
import type { TopologyRequestContext } from './access';
import { GraphReadError, graphAuthority } from './graphCursor';
import { missingSubject, nodeExposure, nodeLabelSql, relationshipExposure, scoped } from './graphRead';
import { readTopologySubjectHealth, type TopologyHealthContribution } from './subjectHealth';
import { buildTopologyTraceViews } from './tracerouteResults';

/**
 * Cautious incident impact (M3 Task 10, operations spec §13).
 *
 * Given one subject (node or relationship) that failed — or that the caller
 * asks "what if it failed" about — this explains, deterministically and within
 * fixed bounds, which entities MAY depend on it, which failures are actually
 * MEASURED, and what is assumed. It is an explanation, never an action:
 *  - nothing here (or in its loader) suppresses, acknowledges, closes,
 *    downgrades or re-evaluates an alert, writes a row, or dispatches a probe;
 *  - traversal runs over the AUTHORIZED CANONICAL graph at a pinned revision:
 *    per-view exclusions are presentation state and never change impact
 *    inputs (M2 D17); resources the reader cannot see are filtered before
 *    traversal, so no path is routed through a hidden record;
 *  - only port/route carriers (physical_link, attachment, default_route,
 *    egress_path) form dependency paths; a network membership is a possible
 *    group only, never cable dependence;
 *  - dependency is the shortest-path model from known upstream anchors
 *    (gateway/internet nodes, router/firewall roles). A node depends on the
 *    subject when one of its shortest paths crosses it. When a path remains
 *    without the subject, the answer is "alternative path exists, availability
 *    unverified" — forwarding/HA state is never observed here; when none
 *    remains, "no known alternative path", which is still only POSSIBLE loss;
 *  - every uncertain segment (attachment, FDB, inferred, manual, stale, low
 *    confidence, unknown directness, VPN, logical route) is labelled on the
 *    entity it reaches; no certainty is ever promoted;
 *  - a cause is only ever "possible", and only with a fresh measured failure
 *    on the subject corroborated by fresh failures on dependent entities.
 */

export type ImpactNode = { id: string; kind: string; role: string | null; label: string };
export type ImpactRelationship = {
  id: string;
  kind: 'network_member' | 'default_route' | 'egress_path' | 'physical_link' | 'attachment';
  sourceNodeId: string;
  targetNodeId: string;
  directness: 'direct' | 'via_unmanaged' | 'unknown';
  confidence: 'high' | 'medium' | 'low' | 'asserted';
  evidenceClass: 'observed' | 'inferred' | 'manual';
  method: string | null;
  association: string | null;
  /** Latest active support freshness; null when unsupported (manual/legacy). */
  freshUntil: string | null;
};
export type ImpactGraph = {
  siteId: string;
  graphRevision: string;
  healthRevision: string;
  nodes: ImpactNode[];
  relationships: ImpactRelationship[];
  /** The loader hit its row cap: the graph is incomplete. */
  truncated: boolean;
  /** Physical collector evidence is exposed to this reader (D9/D15.4). */
  physicalExposed: boolean;
};
export type ImpactSubject = { kind: 'node' | 'relationship'; id: string };
export type ImpactHealthEvidence = {
  subject: ImpactSubject;
  status: HealthStatus;
  freshness: Freshness;
  evidenceId: string;
  evidenceKind: 'monitor_result' | 'interface_measurement' | 'diagnostic_run';
  /** Measurement context/origin; a failure next to a success in another context is location-specific. */
  contextKey: string;
};
export type ImpactEvidence = {
  window: TopologyImpactResponse['window'];
  health: ImpactHealthEvidence[];
  routedPaths: TopologyImpactResponse['routedPaths'];
};
export type ImpactOptions = { now?: Date; clock?: () => number };

const CARRIERS: ReadonlySet<string> = new Set(['physical_link', 'attachment', 'default_route', 'egress_path']);
const ROOT_KINDS: ReadonlySet<string> = new Set(['gateway', 'internet']);
const ROOT_ROLES: ReadonlySet<string> = new Set(['router', 'firewall']);
const INFRASTRUCTURE_KINDS: ReadonlySet<string> = new Set(['gateway', 'internet', 'network']);
const INFRASTRUCTURE_ROLES: ReadonlySet<string> = new Set(['switch', 'router', 'access_point', 'firewall']);
const L = TOPOLOGY_IMPACT_LIMITS;
const FAILED: ReadonlySet<HealthStatus> = new Set(['failed_check', 'degraded']);
const RANK: Record<HealthStatus, number> = { unknown: 0, healthy: 1, degraded: 2, failed_check: 3 };

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isRoot = (node: ImpactNode) => ROOT_KINDS.has(node.kind) || ROOT_ROLES.has(node.role ?? '');
const isInfrastructure = (node: ImpactNode) => INFRASTRUCTURE_KINDS.has(node.kind) || INFRASTRUCTURE_ROLES.has(node.role ?? '');

/** Uncertainty labels a segment contributes to every entity reached through it. */
function segmentFlags(rel: ImpactRelationship, nowMs: number): string[] {
  const flags: string[] = [];
  if (rel.kind === 'attachment') flags.push('path_via_attachment');
  if (rel.kind === 'default_route' || rel.kind === 'egress_path') flags.push('path_via_logical_route');
  if (rel.evidenceClass === 'inferred') flags.push('path_via_inferred_relationship');
  if (rel.evidenceClass === 'manual') flags.push('path_via_manual_relationship');
  if (rel.method === 'fdb') flags.push('path_via_fdb_inference');
  if (rel.directness === 'unknown') flags.push('path_directness_unknown');
  if (rel.directness === 'via_unmanaged') flags.push('path_via_unmanaged_segment');
  if (rel.confidence === 'low') flags.push('path_low_confidence');
  if (rel.evidenceClass !== 'manual' && !(rel.freshUntil && Date.parse(rel.freshUntil) > nowMs)) flags.push('path_evidence_stale');
  if (rel.association === 'vpn') flags.push('path_via_vpn');
  return flags;
}

type Edge = { to: string; rel: ImpactRelationship };
type Dependent = { parent: string; rel: ImpactRelationship; path: string[]; pathTruncated: boolean; hops: number; flags: Set<string> };

class Deadline {
  private ops = 0;
  expired = false;
  constructor(private readonly clock: () => number, private readonly at: number) {}
  /** Checked on the first and every 256th step so a stalled traversal stops promptly. */
  tick(): boolean {
    if (!this.expired && this.ops++ % 256 === 0 && this.clock() >= this.at) this.expired = true;
    return this.expired;
  }
}

/** Multi-source BFS from the anchors; `skip` removes the failed element. Neighbours are pre-sorted, so order is deterministic. */
function bfs(
  roots: string[], adjacency: Map<string, Edge[]>, deadline: Deadline, skip: { node: string | null; rel: string | null },
): { dist: Map<string, number>; order: string[]; parent: Map<string, Edge> } {
  const dist = new Map<string, number>(); const parent = new Map<string, Edge>(); const order: string[] = [];
  for (const root of roots) { if (root !== skip.node) { dist.set(root, 0); order.push(root); } }
  for (let head = 0; head < order.length; head += 1) {
    if (deadline.tick()) break;
    const current = order[head]!;
    for (const edge of adjacency.get(current) ?? []) {
      if (edge.rel.id === skip.rel || edge.to === skip.node || dist.has(edge.to)) continue;
      dist.set(edge.to, dist.get(current)! + 1); parent.set(edge.to, { to: current, rel: edge.rel }); order.push(edge.to);
    }
  }
  return { dist, order, parent };
}

/** Pure, deterministic, bounded analysis used by `getTopologyImpact`. */
export function analyzeTopologyImpact(
  graph: ImpactGraph, effect: ImpactSubject, evidence: ImpactEvidence, budgetMs: number, options: ImpactOptions = {},
): TopologyImpactResponse {
  const clock = options.clock ?? (() => performance.now());
  const deadline = new Deadline(clock, clock() + Math.max(0, budgetMs));
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const reasons = new Set<string>(); const assumptions = new Set<string>(['shortest_path_dependency_model', 'routing_context_not_distinguished']);
  let partial = false;
  const markPartial = (code: string) => { partial = true; reasons.add(code); };

  if (graph.truncated || graph.nodes.length > L.maxNodes || graph.relationships.length > L.maxRelationships) markPartial('traversal_limit');
  if (!graph.physicalExposed) assumptions.add('physical_evidence_unavailable');
  const nodes = [...graph.nodes].sort(byId).slice(0, L.maxNodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  // A relationship is traversable only when BOTH endpoints are visible to this reader.
  const relationships = [...graph.relationships].sort(byId).slice(0, L.maxRelationships)
    .filter((rel) => rel.sourceNodeId !== rel.targetNodeId && nodeById.has(rel.sourceNodeId) && nodeById.has(rel.targetNodeId));
  const relById = new Map(relationships.map((rel) => [rel.id, rel]));

  const subjectPresent = effect.kind === 'node' ? nodeById.has(effect.id) : relById.has(effect.id);
  if (!subjectPresent) markPartial('subject_not_in_graph');
  const failedNode = effect.kind === 'node' ? effect.id : null;
  const failedRel = effect.kind === 'relationship' ? relById.get(effect.id) ?? null : null;

  // ---- dependency traversal ----
  const adjacency = new Map<string, Edge[]>();
  const pairCount = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const rel of relationships) {
    if (!CARRIERS.has(rel.kind)) continue;
    for (const [from, to] of [[rel.sourceNodeId, rel.targetNodeId], [rel.targetNodeId, rel.sourceNodeId]] as const) {
      adjacency.set(from, [...(adjacency.get(from) ?? []), { to, rel }]);
    }
    pairCount.set(pairKey(rel.sourceNodeId, rel.targetNodeId), (pairCount.get(pairKey(rel.sourceNodeId, rel.targetNodeId)) ?? 0) + 1);
  }
  for (const edges of adjacency.values()) edges.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : byId(a.rel, b.rel)));

  const dependents = new Map<string, Dependent>();
  const alternatives: TopologyImpactResponse['alternatives'] = [];
  const affected: TopologyImpactResponse['potentiallyAffected'] = [];
  // A failed anchor stays an anchor of the full graph (its dependents are found through it) and is removed from the residual.
  const roots = nodes.filter(isRoot).map((node) => node.id);
  if (roots.length > 1) assumptions.add('multiple_upstream_anchors');

  if (failedRel && !CARRIERS.has(failedRel.kind)) {
    assumptions.add('membership_not_dependency');
  } else if (subjectPresent && !roots.length) {
    assumptions.add('no_upstream_anchor'); markPartial('upstream_unknown');
  } else if (subjectPresent) {
    const full = bfs(roots, adjacency, deadline, { node: null, rel: null });
    // A node depends on the subject when one of its shortest-path predecessors
    // is the failed node, is reached over the failed relationship, or depends.
    for (const nodeId of full.order) {
      if (deadline.tick()) break;
      const d = full.dist.get(nodeId)!;
      if (d === 0 || nodeId === failedNode) continue;
      for (const edge of adjacency.get(nodeId) ?? []) {
        if (full.dist.get(edge.to) !== d - 1) continue;
        const viaFailure = edge.rel.id === failedRel?.id || edge.to === failedNode;
        const upstream = dependents.get(edge.to);
        if (!viaFailure && !upstream) continue;
        let entry = dependents.get(nodeId);
        if (!entry) {
          // The cited path starts at the failed link (or the failed node's link) and extends one segment per hop.
          const full = !viaFailure && upstream!.path.length >= L.maxPathRelationships;
          entry = {
            parent: edge.to, rel: edge.rel,
            path: viaFailure ? [edge.rel.id] : full ? [...upstream!.path] : [...upstream!.path, edge.rel.id],
            pathTruncated: full || !!upstream?.pathTruncated,
            hops: viaFailure ? 1 : upstream!.hops + 1, flags: new Set(),
          };
          dependents.set(nodeId, entry);
        }
        for (const flag of segmentFlags(edge.rel, nowMs)) entry.flags.add(flag);
        for (const flag of upstream?.flags ?? []) entry.flags.add(flag);
      }
    }
    if (dependents.size) {
      const residual = bfs(roots, adjacency, deadline, { node: failedNode, rel: failedRel?.id ?? null });
      for (const [nodeId, entry] of [...dependents].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const nodeReasons = new Set<string>();
        if (residual.dist.has(nodeId)) {
          nodeReasons.add('alternative_path_unverified');
          assumptions.add('forwarding_state_unverified');
          if ((pairCount.get(pairKey(entry.parent, nodeId)) ?? 0) > 1) nodeReasons.add('parallel_link_present');
          const pathIds: string[] = []; const altReasons = new Set<string>();
          for (let cursor = nodeId, steps = 0; residual.parent.has(cursor); steps += 1) {
            const step = residual.parent.get(cursor)!;
            if (steps >= L.maxPathRelationships) { altReasons.add('path_truncated'); break; }
            pathIds.unshift(step.rel.id);
            if (step.to !== nodeId && residual.dist.get(step.to)! > 0 && !isInfrastructure(nodeById.get(step.to)!)) altReasons.add('alternative_via_endpoint_transit');
            cursor = step.to;
          }
          if (alternatives.length < L.maxAlternatives) alternatives.push({ nodeId, relationshipIds: pathIds, state: 'unverified', reasons: [...altReasons].sort() });
          else reasons.add('alternatives_bounded');
        } else {
          nodeReasons.add('no_known_alternative_path');
        }
        if (entry.pathTruncated) nodeReasons.add('path_truncated');
        for (const flag of [...entry.flags].sort()) nodeReasons.add(flag);
        affected.push({ kind: 'node', id: nodeId, label: nodeById.get(nodeId)!.label, basis: 'dependency_path', hops: entry.hops, reasons: [...nodeReasons], evidenceIds: entry.path });
      }
    }
    if (deadline.expired) markPartial('traversal_deadline');
  }

  // A failed network/group: its members are a POSSIBLE group, never a cable dependency.
  if (failedNode && subjectPresent) {
    const seen = new Set(affected.map((entry) => entry.id));
    for (const rel of relationships) {
      if (rel.kind !== 'network_member') continue;
      const member = rel.sourceNodeId === failedNode ? rel.targetNodeId : rel.targetNodeId === failedNode ? rel.sourceNodeId : null;
      if (!member || seen.has(member)) continue;
      seen.add(member);
      affected.push({ kind: 'node', id: member, label: nodeById.get(member)!.label, basis: 'group_membership', hops: 1, reasons: ['group_member_possible'], evidenceIds: [rel.id] });
    }
  }

  // ---- measured evidence ----
  const inGraph = (subject: ImpactSubject) => (subject.kind === 'node' ? nodeById.has(subject.id) : relById.has(subject.id));
  const bySubject = new Map<string, ImpactHealthEvidence[]>();
  for (const item of [...evidence.health].sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0))) {
    if (!inGraph(item.subject)) { reasons.add('evidence_outside_graph_ignored'); continue; }
    const key = `${item.subject.kind}:${item.subject.id}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), item]);
  }
  const freshFailures = (key: string) => (bySubject.get(key) ?? []).filter((e) => e.freshness === 'fresh' && FAILED.has(e.status));
  const freshSuccesses = (key: string) => (bySubject.get(key) ?? []).filter((e) => e.freshness === 'fresh' && e.status === 'healthy');
  const cited = new Map<string, TopologyImpactResponse['evidence'][number]['kind']>();
  const cite = (evidenceId: string, kind: TopologyImpactResponse['evidence'][number]['kind']) => { if (!cited.has(evidenceId)) cited.set(evidenceId, kind); };

  const measuredFailures: TopologyImpactResponse['measuredFailures'] = [];
  for (const key of [...bySubject.keys()].sort()) {
    const failures = freshFailures(key);
    if ([...(bySubject.get(key) ?? [])].some((e) => e.freshness !== 'fresh' && FAILED.has(e.status)) && !failures.length) reasons.add('failure_evidence_stale');
    if (!failures.length) continue;
    const [kind, subjectId] = key.split(':') as [ImpactSubject['kind'], string];
    const status = failures.reduce<HealthStatus>((worst, e) => (RANK[e.status] > RANK[worst] ? e.status : worst), 'degraded') as 'failed_check' | 'degraded';
    const failureContexts = new Set(failures.map((e) => e.contextKey));
    const contradicting = freshSuccesses(key).filter((e) => !failureContexts.has(e.contextKey));
    const ids = [...failures, ...contradicting].slice(0, 16);
    for (const e of ids) cite(e.evidenceId, e.evidenceKind);
    if (measuredFailures.length >= L.maxMeasuredFailures) { markPartial('measured_failures_bounded'); break; }
    measuredFailures.push({ kind, id: subjectId, status, evidenceIds: ids.map((e) => e.evidenceId), reasons: contradicting.length ? ['location_specific_possible'] : [] });
  }
  const subjectKey = `${effect.kind}:${effect.id}`;
  const measured = subjectPresent && freshFailures(subjectKey).length > 0;
  if (!measured) assumptions.add('subject_failure_hypothetical');

  const corroborating: string[] = [];
  for (const entry of affected) {
    const key = `node:${entry.id}`;
    if (freshFailures(key).length) { entry.reasons.push('failure_measured'); if (entry.basis === 'dependency_path') corroborating.push(entry.id); }
    if (freshSuccesses(key).length) { entry.reasons.push('contradicting_success_observed'); for (const e of freshSuccesses(key).slice(0, 4)) cite(e.evidenceId, e.evidenceKind); }
    entry.reasons = entry.reasons.slice(0, 24);
  }
  const causeSuggestion: TopologyImpactResponse['causeSuggestion'] = !measured
    ? { state: 'not_suggested', corroboratingIds: [], reasons: ['subject_failure_unmeasured'] }
    : corroborating.length
      ? { state: 'possible', corroboratingIds: corroborating.sort().slice(0, 16), reasons: ['corroborated_by_dependent_failures', 'context_compatibility_unverified'] }
      : { state: 'not_suggested', corroboratingIds: [], reasons: ['no_corroborating_failures'] };

  // ---- bound and cite ----
  affected.sort((a, b) => a.hops - b.hops || byId(a, b));
  const total = affected.length;
  const potentiallyAffected = affected.slice(0, L.maxPotentiallyAffected);
  if (total > potentiallyAffected.length) markPartial('result_limit');
  alternatives.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  if (failedRel) cite(failedRel.id, 'relationship');
  for (const entry of potentiallyAffected) for (const relId of entry.evidenceIds) cite(relId, 'relationship');
  for (const alternative of alternatives) for (const relId of alternative.relationshipIds) cite(relId, 'relationship');
  const routedPaths = evidence.routedPaths.slice(0, L.maxRoutedPaths);
  for (const path of routedPaths) cite(path.runId, 'diagnostic_run');
  const evidenceList = [...cited].map(([evidenceId, kind]) => ({ id: evidenceId, kind }));
  if (evidenceList.length > L.maxEvidence) reasons.add('evidence_list_bounded');

  return {
    siteId: graph.siteId, graphRevision: graph.graphRevision, healthRevision: graph.healthRevision,
    subject: { kind: effect.kind, id: effect.id, measured },
    window: evidence.window,
    measuredFailures, potentiallyAffected, alternatives, routedPaths, causeSuggestion,
    assumptions: [...assumptions].sort().slice(0, 32),
    coverage: partial ? 'partial' : 'complete',
    reasons: [...reasons].sort().slice(0, 64),
    counts: { nodes: nodes.length, relationships: relationships.length, potentiallyAffected: total, omittedPotentiallyAffected: total - potentiallyAffected.length },
    evidence: evidenceList.slice(0, L.maxEvidence),
    asOf: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scoped loader (read-only: no write, no command, no job, no model call)
// ---------------------------------------------------------------------------
type ReadTx = Pick<typeof db, 'execute'>;
type RelationshipRow = Omit<ImpactRelationship, 'freshUntil'> & { freshUntil: string | Date | null; lifecycle: string };
type RunRow = {
  id: string; recipeId: string; assessment: HealthStatus; subjectNodeId: string | null; subjectRelationshipId: string | null;
  originNodeId: string; finishedAt: string | Date | null; plan: TopologyDiagnosticPlan;
};
/** Health evidence is read for at most this many subjects (the /health endpoint's bounds). */
export const IMPACT_HEALTH_SUBJECTS = { nodes: 1_000, relationships: 2_000 } as const;
const MAX_RUNS = 100;
const iso = (value: string | Date | null) => (value ? new Date(value).toISOString() : null);
const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const parse = (query: unknown) => {
  const parsed = topologyImpactQuerySchema.safeParse(query);
  if (!parsed.success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid topology impact query');
  return parsed.data;
};

/** One contribution → one cited evidence item. Unknown statuses are neither failures nor successes. */
function contributionEvidence(c: TopologyHealthContribution): ImpactHealthEvidence | null {
  if (c.status === 'unknown') return null;
  const [kind, evidenceId] = c.source === 'interface'
    ? ['interface_measurement' as const, `interface:${c.key.split(':').at(-1)}`]
    : c.source === 'policy' ? ['diagnostic_run' as const, c.resultId ?? c.key] : ['monitor_result' as const, c.resultId ?? c.key];
  return { subject: c.subject, status: c.status, freshness: c.freshness, evidenceId: evidenceId.slice(0, 128), evidenceKind: kind, contextKey: c.contextKey };
}

async function loadGraph(tx: ReadTx, ctx: TopologyRequestContext, physical: boolean, subject: ImpactSubject) {
  const nodes = await tx.execute<ImpactNode>(sql`SELECT n.id, n.kind, n.role, ${nodeLabelSql} AS label FROM topology_nodes n
    WHERE ${scoped(ctx.scope, 'n')} AND n.deleted_at IS NULL AND n.alias_target_id IS NULL AND n.lifecycle = 'active'
      AND ${nodeExposure(ctx.scope, { physical }, 'n')}
    ORDER BY n.id LIMIT ${TOPOLOGY_IMPACT_LIMITS.maxNodes + 1}`);
  // Canonical traversal: the physical gate applies, per-view exclusions never do (M2 D17).
  // A non-active subject relationship is still loaded so its former dependents can be explained.
  const rows = await tx.execute<RelationshipRow>(sql`SELECT r.id, r.kind, r.source_node_id AS "sourceNodeId", r.target_node_id AS "targetNodeId",
      r.directness, r.confidence, r.evidence_class AS "evidenceClass", r.lifecycle, r.attributes->>'method' AS method,
      r.attributes->'physical'->>'association' AS association,
      (SELECT max(rs.fresh_until) FROM topology_relationship_support rs
        WHERE rs.org_id = r.org_id AND rs.site_id = r.site_id AND rs.relationship_id = r.id AND rs.lifecycle = 'active') AS "freshUntil"
    FROM topology_relationships r
    WHERE ${scoped(ctx.scope, 'r')} AND r.deleted_at IS NULL
      AND (r.lifecycle = 'active' ${subject.kind === 'relationship' ? sql`OR r.id = ${subject.id}::uuid` : sql``})
      AND ${relationshipExposure({ physical }, 'r')}
    ORDER BY r.id LIMIT ${TOPOLOGY_IMPACT_LIMITS.maxRelationships + 1}`);
  return {
    nodes: [...nodes],
    relationships: rows.map(({ lifecycle: _lifecycle, freshUntil, ...rel }) => ({ ...rel, freshUntil: iso(freshUntil) })),
    subjectInactive: subject.kind === 'relationship' && rows.some((row) => row.id === subject.id && row.lifecycle !== 'active'),
    truncated: nodes.length > TOPOLOGY_IMPACT_LIMITS.maxNodes || rows.length > TOPOLOGY_IMPACT_LIMITS.maxRelationships,
  };
}

async function loadRuns(tx: ReadTx, ctx: TopologyRequestContext, nodeIds: string[], relationshipIds: string[], window: ImpactEvidence['window'], physical: boolean) {
  if (!nodeIds.length && !relationshipIds.length) return { health: [], routedPaths: [] };
  const runs = await tx.execute<RunRow>(sql`SELECT r.id, r.recipe_id AS "recipeId", r.assessment, r.subject_node_id AS "subjectNodeId",
      r.subject_relationship_id AS "subjectRelationshipId", r.origin_node_id AS "originNodeId", r.finished_at AS "finishedAt", r.plan
    FROM topology_diagnostic_runs r
    WHERE ${scoped(ctx.scope, 'r')} AND r.state IN ('completed','failed')
      AND r.finished_at >= ${window.from}::timestamptz AND r.finished_at <= ${window.to}::timestamptz
      AND (r.subject_node_id = ANY(${uuidArray(nodeIds)}) OR r.subject_relationship_id = ANY(${uuidArray(relationshipIds)}))
      AND (r.subject_relationship_id IS NULL OR EXISTS (SELECT 1 FROM topology_relationships x WHERE ${scoped(ctx.scope, 'x')}
        AND x.id = r.subject_relationship_id AND ${relationshipExposure({ physical }, 'x')}))
    ORDER BY r.finished_at DESC, r.id LIMIT ${MAX_RUNS}`);
  const health: ImpactHealthEvidence[] = runs.map((run) => ({
    subject: run.subjectNodeId ? { kind: 'node', id: run.subjectNodeId } : { kind: 'relationship', id: run.subjectRelationshipId! },
    status: run.assessment, freshness: 'fresh', evidenceId: run.id, evidenceKind: 'diagnostic_run', contextKey: `origin:${run.originNodeId}`,
  }));
  // Routed traces are cited as OBSERVED routed paths only; a hop never becomes a node or relationship.
  const traces = runs.filter((run) => run.recipeId === 'trace_route').slice(0, TOPOLOGY_IMPACT_LIMITS.maxRoutedPaths);
  const steps = traces.length ? await tx.execute<{ runId: string; result: TopologyDiagnosticStep }>(sql`SELECT s.run_id AS "runId", s.result
    FROM topology_diagnostic_steps s WHERE ${scoped(ctx.scope, 's')} AND s.historical_only = false AND s.run_id = ANY(${uuidArray(traces.map((run) => run.id))})
    ORDER BY s.run_id, s.created_at, s.id LIMIT ${TOPOLOGY_IMPACT_LIMITS.maxRoutedPaths * 32}`) : [];
  const routedPaths: TopologyImpactResponse['routedPaths'] = [];
  for (const run of traces) {
    for (const view of buildTopologyTraceViews(run.plan, steps.filter((step) => step.runId === run.id).map((step) => step.result))) {
      if (routedPaths.length >= TOPOLOGY_IMPACT_LIMITS.maxRoutedPaths) break;
      routedPaths.push({ runId: run.id, stepId: view.stepId, kind: 'observed_routed_path', destinationReached: view.destinationReached,
        respondingHops: Math.min(64, view.hops.filter((hop) => hop.responders.length).length),
        gapHops: Math.min(64, view.hops.filter((hop) => !hop.responders.length).length), truncated: view.truncated, finishedAt: iso(run.finishedAt) });
    }
  }
  return { health, routedPaths };
}

/**
 * Scoped, bounded incident impact for one subject at a pinned graph revision.
 * Reads only: canonical graph + existing health contributions + recent
 * diagnostic runs. A changed revision is a 409 (there is no historical graph
 * snapshot to traverse). Traversal plus evidence share a 2-second budget.
 */
export async function getTopologyImpact(
  ctx: TopologyRequestContext,
  subject: ImpactSubject,
  query: { graphRevision?: string; windowMinutes?: number },
): Promise<TopologyImpactResponse> {
  const parsed = parse({ subjectKind: subject.kind, subjectId: subject.id, ...query });
  const effect: ImpactSubject = { kind: parsed.subjectKind, id: parsed.subjectId };
  const started = performance.now();
  const authority = await graphAuthority(ctx);
  return db.transaction(async (tx) => {
    // Publication and lifecycle writers lock this row; SHARE pins every read below to one revision.
    const [state] = await tx.execute<{ graph: string; health: string }>(sql`SELECT graph_revision::text AS graph, health_revision::text AS health
      FROM topology_site_state s WHERE ${scoped(ctx.scope, 's')} FOR SHARE`);
    const graphRevision = state?.graph ?? '0';
    if (parsed.graphRevision !== undefined && parsed.graphRevision !== graphRevision) {
      throw new GraphReadError('graph_revision_changed', 409, 'Topology graph changed; reload the projection');
    }
    const [present] = effect.kind === 'node'
      ? await tx.execute<{ id: string }>(sql`SELECT n.id FROM topology_nodes n WHERE ${scoped(ctx.scope, 'n')} AND n.id = ${effect.id}::uuid
          AND n.deleted_at IS NULL AND n.alias_target_id IS NULL AND n.lifecycle = 'active' AND ${nodeExposure(ctx.scope, authority, 'n')} LIMIT 1`)
      : await tx.execute<{ id: string }>(sql`SELECT r.id FROM topology_relationships r WHERE ${scoped(ctx.scope, 'r')} AND r.id = ${effect.id}::uuid
          AND r.deleted_at IS NULL AND ${relationshipExposure({ physical: authority.physical }, 'r')} LIMIT 1`);
    if (!present) throw missingSubject();

    const loaded = await loadGraph(tx, ctx, authority.physical, effect);
    const now = new Date();
    const window = { minutes: parsed.windowMinutes, from: new Date(now.getTime() - parsed.windowMinutes * 60_000).toISOString(), to: now.toISOString() };
    const graph: ImpactGraph = { siteId: ctx.scope.siteId, graphRevision, healthRevision: state?.health ?? '0',
      nodes: loaded.nodes, relationships: loaded.relationships, truncated: loaded.truncated, physicalExposed: authority.physical };
    const remaining = () => TOPOLOGY_IMPACT_LIMITS.deadlineMs - (performance.now() - started);

    // Pass 1 (no evidence) finds the candidate subjects; evidence is then read for those only.
    const candidates = analyzeTopologyImpact(graph, effect, { window, health: [], routedPaths: [] }, remaining(), { now });
    const allNodeIds = [...new Set([...(effect.kind === 'node' ? [effect.id] : []), ...candidates.potentiallyAffected.map((entry) => entry.id)])];
    const allRelIds = [...new Set([...(effect.kind === 'relationship' ? [effect.id] : []), ...candidates.potentiallyAffected.flatMap((entry) => entry.evidenceIds)])];
    const nodeIds = allNodeIds.slice(0, IMPACT_HEALTH_SUBJECTS.nodes);
    const relIds = allRelIds.slice(0, IMPACT_HEALTH_SUBJECTS.relationships);
    const contributions = await readTopologySubjectHealth({ executor: tx as ReadTx, ctx, now, exposure: { interfaceHealth: authority.interfaceHealth },
      subjects: [...nodeIds.map((id) => ({ kind: 'node' as const, id })), ...relIds.map((id) => ({ kind: 'relationship' as const, id }))] });
    const runs = await loadRuns(tx, ctx, nodeIds, relIds, window, authority.physical);
    const health = [...[...contributions.values()].flat().map(contributionEvidence).filter((e): e is ImpactHealthEvidence => !!e), ...runs.health];

    const result = analyzeTopologyImpact(graph, effect, { window, health, routedPaths: runs.routedPaths }, remaining(), { now });
    const extra: string[] = [];
    if (loaded.subjectInactive) extra.push('subject_relationship_not_active');
    if (allNodeIds.length > nodeIds.length || allRelIds.length > relIds.length) extra.push('health_evidence_bounded');
    if (!extra.length) return result;
    return { ...result, coverage: extra.includes('health_evidence_bounded') ? 'partial' : result.coverage,
      reasons: [...new Set([...result.reasons, ...extra])].sort().slice(0, 64) };
  });
}
