/**
 * Topology M4 Task 1 (#6000): bounded, allowlisted AI projections over the
 * scoped topology reads. Every function takes the gate-issued
 * `TopologyRequestContext` (site already pinned and authorized — see
 * `aiToolGate.ts`) and calls the SAME scoped services the REST routes use, so
 * org/site RLS, the physical/interface-health exposure flags and the M0/M1
 * resource checks all apply unchanged. Nothing here probes, polls, queues a
 * command, schedules, or calls a model.
 *
 * Projection is by ALLOWLIST, never by deleting keys from a service response:
 * a new service field stays out of the model's view until it is added here.
 * Cursor/frontier tokens, layout, presentation-only rows, UI permissions,
 * raw addresses and raw collector payloads are never projected. Untrusted text
 * passes `sanitizeTopologyAiText` and is listed in `untrustedFields`.
 */
import type { GraphNode, GraphRelationship, GraphResponse, TopologyDiagnosticRun } from '@breeze/shared';
import type { TopologyRequestContext } from './access';
import { createTopologyAiAliasContext, type TopologyAiAliasContext } from './aiEvidence';
import { sanitizeTopologyAiText } from './aiRedaction';
import { getTopologyDiagnosticRun } from './diagnosticRuns';
import { getTopologyGraph, getTopologyRelationshipEvidence } from './graph';

export const AI_TOPOLOGY_MAX_NODES = 150;
export const AI_TOPOLOGY_MAX_RELATIONSHIPS = 250;
export const AI_TOPOLOGY_MAX_OBSERVATIONS = 100;
export const AI_TOPOLOGY_MAX_CONFIRMATIONS = 50;
export const AI_TOPOLOGY_MAX_RUN_STEPS = 30;
const DEFAULT_NODES = 50;

export type TopologyReadToolName = 'get_topology' | 'get_link_evidence' | 'get_diagnostic_run';

export type TopologyAiGraphInput = { view?: 'overview' | 'physical' | 'logical'; focusNodeId?: string; graphRevision?: string; limit?: number };
export type TopologyAiEvidenceInput = { relationshipId: string; limit?: number; cursor?: string };
export type TopologyAiRunInput = { runId: string };

export type TopologyAiReadError = { error: string; graphRevision?: string };

const healthView = (health: GraphNode['health']) => ({
  status: health.status, coverage: health.coverage, freshness: health.freshness,
  reasons: health.reasons.slice(0, 8).map((reason) => reason.code),
});

function nodeView(node: GraphNode, flags: Set<string>, aliases: TopologyAiAliasContext) {
  return {
    // Host identity → per-investigation alias (M4 Task 2); never the collected name.
    id: node.id, alias: aliases.alias('host', node.label), kind: node.kind, role: sanitizeTopologyAiText(node.role, flags),
    bindingKinds: [...new Set(node.bindings.map((binding) => binding.type))].sort(),
    lifecycle: node.lifecycle, freshness: node.freshness,
    evidence: { classes: node.evidence.classes, methods: node.evidence.methods, count: node.evidence.count, lastObservedAt: node.evidence.lastObservedAt },
    health: healthView(node.health),
  };
}

function relationshipView(rel: GraphRelationship) {
  return {
    id: rel.id, kind: rel.kind, sourceNodeId: rel.sourceNodeId, targetNodeId: rel.targetNodeId,
    sourceInterfaceId: rel.sourceInterfaceId, targetInterfaceId: rel.targetInterfaceId,
    directness: rel.directness, confidence: rel.confidence, lifecycle: rel.lifecycle, freshness: rel.freshness, excluded: rel.excluded,
    evidence: { classes: rel.evidence.classes, methods: rel.evidence.methods, count: rel.evidence.count, lastObservedAt: rel.evidence.lastObservedAt },
    health: healthView(rel.health),
  };
}

/** Aliases for one tool call: the investigation's scope, or a request-local one. */
export function topologyAiReadAliases(aliasScope: string | undefined): TopologyAiAliasContext {
  return createTopologyAiAliasContext(aliasScope ?? `request:${crypto.randomUUID()}`);
}

/** Bounded graph slice for one view (≤150 nodes, ≤250 relationships), with explicit omissions. */
export async function readTopologyAiGraph(ctx: TopologyRequestContext, input: TopologyAiGraphInput, aliases: TopologyAiAliasContext = topologyAiReadAliases(undefined)) {
  const limit = Math.min(AI_TOPOLOGY_MAX_NODES, Math.max(1, Math.trunc(input.limit ?? DEFAULT_NODES)));
  const graph: GraphResponse = await getTopologyGraph(ctx, {
    view: input.view ?? 'overview',
    ...(input.focusNodeId ? { focusNodeId: input.focusNodeId } : {}),
    hops: 1, includeHealth: true, limit,
  });
  if (input.graphRevision !== undefined && input.graphRevision !== graph.revisions.graph) {
    return { error: 'graph_revision_changed', graphRevision: graph.revisions.graph } satisfies TopologyAiReadError;
  }
  const flags = new Set<string>();
  const nodes = graph.nodes.slice(0, AI_TOPOLOGY_MAX_NODES);
  const relationships = graph.relationships.slice(0, AI_TOPOLOGY_MAX_RELATIONSHIPS);
  return {
    siteId: graph.siteId, view: graph.view, asOf: graph.asOf,
    revisions: { graph: graph.revisions.graph, health: graph.revisions.health },
    nodes: nodes.map((node) => nodeView(node, flags, aliases)),
    relationships: relationships.map(relationshipView),
    omitted: {
      nodes: graph.counts.omittedNodes + (graph.nodes.length - nodes.length),
      relationships: graph.counts.omittedRelationships + (graph.relationships.length - relationships.length),
    },
    coverage: { state: graph.coverage.state, reasons: graph.coverage.reasons.slice(0, 16).map((reason) => reason.code) },
    untrustedFields: ['nodes[].role'],
    ...(flags.size ? { sanitization: [...flags].sort() } : {}),
  };
}

/** One page (≤100) of observations and confirmations for one relationship. */
export async function readTopologyAiLinkEvidence(ctx: TopologyRequestContext, input: TopologyAiEvidenceInput) {
  const limit = Math.min(AI_TOPOLOGY_MAX_OBSERVATIONS, Math.max(1, Math.trunc(input.limit ?? AI_TOPOLOGY_MAX_OBSERVATIONS)));
  const page = await getTopologyRelationshipEvidence(ctx, input.relationshipId, { limit, ...(input.cursor ? { cursor: input.cursor } : {}) });
  return {
    siteId: page.siteId, graphRevision: page.graphRevision, relationshipId: page.relationshipId,
    observations: page.observations.slice(0, AI_TOPOLOGY_MAX_OBSERVATIONS).map((o) => ({
      id: o.id, method: o.method, evidenceClass: o.evidenceClass, producerKind: o.producerKind, protocol: o.protocol,
      observedAt: o.observedAt, receivedAt: o.receivedAt, freshUntil: o.freshUntil, status: o.status,
    })),
    confirmations: page.confirmations.slice(0, AI_TOPOLOGY_MAX_CONFIRMATIONS).map((c) => ({
      sourceId: c.sourceId, producerKind: c.producerKind, protocol: c.protocol, firstPositiveAt: c.firstPositiveAt,
      lastPositiveAt: c.lastPositiveAt, freshUntil: c.freshUntil, lifecycle: c.lifecycle, completeMissCount: c.completeMissCount,
    })),
    summary: page.summary,
    details: page.details,
    cursor: page.cursor,
  };
}

/** One diagnostic run in the pinned site: states, reasons and measurements — never raw addresses. */
export async function readTopologyAiDiagnosticRun(ctx: TopologyRequestContext, input: TopologyAiRunInput) {
  const run: TopologyDiagnosticRun | null = await getTopologyDiagnosticRun(ctx, input.runId);
  if (!run) return { error: 'Diagnostic run not found' } satisfies TopologyAiReadError;
  const steps = run.steps.slice(0, AI_TOPOLOGY_MAX_RUN_STEPS);
  return {
    id: run.id, state: run.state, assessment: run.assessment, coverage: run.coverage, reasons: run.reasons,
    recipeId: (run.plan as { recipeId?: string }).recipeId ?? null,
    queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt, failureReason: run.failureReason,
    steps: steps.map((step) => ({
      id: step.id, state: step.state, reason: step.reason, truncated: step.truncated,
      method: step.attribution.actualMethod ?? step.attribution.requestedMethod,
      originDeviceId: step.attribution.originDeviceId, destinationId: step.attribution.destinationId,
      family: step.attribution.family, port: step.attribution.port, interfaceId: step.attribution.interfaceId,
      attributionQuality: step.attribution.quality, routeChanged: step.attribution.routeChanged,
      startedAt: step.startedAt, finishedAt: step.finishedAt,
      details: {
        ...(step.details.latencyMs !== undefined ? { latencyMs: step.details.latencyMs } : {}),
        ...(step.details.packetsSent !== undefined ? { packetsSent: step.details.packetsSent } : {}),
        ...(step.details.packetsReceived !== undefined ? { packetsReceived: step.details.packetsReceived } : {}),
        ...(step.details.statusCode !== undefined ? { statusCode: step.details.statusCode } : {}),
        ...(step.details.errorCode !== undefined ? { errorCode: step.details.errorCode } : {}),
        ...(step.details.trace ? { traceHops: step.details.trace.hops.length, destinationReached: step.details.trace.destinationReached } : {}),
      },
    })),
    stepsOmitted: run.steps.length - steps.length,
  };
}

export async function readTopologyAiTool(
  ctx: TopologyRequestContext,
  name: TopologyReadToolName,
  input: TopologyAiGraphInput | TopologyAiEvidenceInput | TopologyAiRunInput,
  aliasScope?: string,
) {
  switch (name) {
    case 'get_topology': return readTopologyAiGraph(ctx, input as TopologyAiGraphInput, topologyAiReadAliases(aliasScope));
    case 'get_link_evidence': return readTopologyAiLinkEvidence(ctx, input as TopologyAiEvidenceInput);
    case 'get_diagnostic_run': return readTopologyAiDiagnosticRun(ctx, input as TopologyAiRunInput);
  }
}
