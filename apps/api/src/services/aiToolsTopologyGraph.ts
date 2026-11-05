/**
 * `get_topology_graph` (full-control W08, #6778): the AI twin of the read
 * routes in routes/topology/graphs.ts — graph, node list, one node, one
 * relationship and its evidence, group members, graph expansions and health.
 *
 * Tier 1, read only. Authorization is the route's: `topologySite(…, 'read')`
 * (topology:read + devices:read, org and site ceilings) on the named site. The
 * data is the SAME scoped service the route calls; the result is projected by
 * ALLOWLIST (the M4 rule in topology/aiRead.ts): ids, kinds, lifecycle,
 * freshness, evidence summary, health codes, sanitised label/role and the
 * device binding ids. Never addresses, MACs, raw attributes or collector
 * payloads, and every collected string passes `sanitizeTopologyAiText`.
 *
 * Distinct from the pinned-investigation tools (`get_topology`,
 * `get_link_evidence`, … — topology/aiToolGate.ts): those serve an agent run
 * or a one-site key; this serves a person in chat or an MCP caller with
 * ordinary site access.
 */
import { graphQuerySchema, type GraphNode, type GraphRelationship, type GraphResponse } from '@breeze/shared';
import type { AiTool } from './aiTools';
import { TOPOLOGY_GRAPH_ACTIONS, TOPOLOGY_NODE_KINDS_ENUM, TOPOLOGY_VIEWS_ENUM } from './aiToolSchemasTopologyOps';
import { boundedJson, defined, jsonError, requireFields, topologySite, topologyThrown } from './aiToolsTopologyShared';
import { sanitizeTopologyAiText } from './topology/aiRedaction';
import { readTopologyAiLinkEvidence } from './topology/aiRead';
import {
  expandTopologyGraph, getTopologyGraph, getTopologyGroupMembers, getTopologyHealth, getTopologyNode,
  getTopologyRelationship, listTopologyNodes,
} from './topology/graph';

type Action = (typeof TOPOLOGY_GRAPH_ACTIONS)[number];

const healthView = (health: GraphNode['health'] | undefined) => health
  ? {
      status: health.status, coverage: health.coverage, freshness: health.freshness,
      reasons: (health.reasons ?? []).slice(0, 8).map((reason) => reason.code),
    }
  : null;

export function projectNode(node: GraphNode, flags: Set<string>) {
  return {
    id: node.id,
    kind: node.kind,
    role: sanitizeTopologyAiText(node.role, flags),
    label: sanitizeTopologyAiText(node.label, flags),
    lifecycle: node.lifecycle,
    freshness: node.freshness,
    bindings: (node.bindings ?? []).slice(0, 20).map((binding) => ({ type: binding.type, referenceId: binding.referenceId })),
    evidence: node.evidence
      ? { classes: node.evidence.classes, methods: node.evidence.methods, count: node.evidence.count, lastObservedAt: node.evidence.lastObservedAt }
      : null,
    health: healthView(node.health),
    ...(node.inventory
      ? {
          inventory: {
            source: node.inventory.source,
            vendor: sanitizeTopologyAiText(node.inventory.vendor, flags),
            model: sanitizeTopologyAiText(node.inventory.model, flags),
            os: sanitizeTopologyAiText(node.inventory.os, flags),
            type: sanitizeTopologyAiText(node.inventory.type, flags),
            presence: node.inventory.presence?.state ?? null,
          },
        }
      : {}),
  };
}

export function projectRelationship(rel: GraphRelationship) {
  return {
    id: rel.id,
    kind: rel.kind,
    sourceNodeId: rel.sourceNodeId,
    targetNodeId: rel.targetNodeId,
    sourceInterfaceId: rel.sourceInterfaceId,
    targetInterfaceId: rel.targetInterfaceId,
    directness: rel.directness,
    confidence: rel.confidence,
    lifecycle: rel.lifecycle,
    freshness: rel.freshness,
    excluded: rel.excluded,
    evidence: rel.evidence
      ? { classes: rel.evidence.classes, methods: rel.evidence.methods, count: rel.evidence.count, lastObservedAt: rel.evidence.lastObservedAt }
      : null,
    health: healthView(rel.health),
  };
}

function projectGraph(graph: GraphResponse, flags: Set<string>) {
  return {
    siteId: graph.siteId,
    view: graph.view,
    asOf: graph.asOf,
    revisions: { graph: graph.revisions.graph, health: graph.revisions.health },
    nodes: graph.nodes.map((node) => projectNode(node, flags)),
    relationships: graph.relationships.map(projectRelationship),
    counts: graph.counts,
    coverage: { state: graph.coverage.state, reasons: (graph.coverage.reasons ?? []).slice(0, 16).map((reason) => reason.code) },
    // Opaque continuation tokens for `expansion` (a collapsed group, or the rest of a bounded read).
    frontier: (graph.frontier ?? []).slice(0, 50).map((entry) => ({
      token: entry.token, label: sanitizeTopologyAiText(entry.label, flags), memberCount: entry.memberCount,
    })),
  };
}

const withSanitization = (flags: Set<string>, body: Record<string, unknown>) => ({
  ...body,
  untrustedFields: ['nodes[].label', 'nodes[].role', 'nodes[].inventory', 'frontier[].label'],
  ...(flags.size ? { sanitization: [...flags].sort() } : {}),
});

export function registerTopologyGraphTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_topology_graph', {
    tier: 1,
    domain: 'network',
    searchHint: 'network topology map: nodes, links, one device or link in detail, group members, health at a site',
    deviceArgs: ['deviceId'],
    captureExempt: true,
    definition: {
      name: 'get_topology_graph',
      description:
        'Read a site\'s network topology. Actions: graph (view,focusNodeId,hops,limit),nodes (q,kind,deviceId),node,relationship,evidence,group_members,expansion (token),health (nodeIds,relationshipIds). Stored evidence only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TOPOLOGY_GRAPH_ACTIONS], description: 'The read to perform' },
          siteId: { type: 'string', description: 'Site UUID' },
          view: { type: 'string', enum: [...TOPOLOGY_VIEWS_ENUM], description: 'graph/group_members: projection (default overview)' },
          focusNodeId: { type: 'string', description: 'graph: node UUID to center a neighbourhood on' },
          hops: { type: 'number', description: 'graph: neighbourhood hops 0-2 (default 1)' },
          includeHealth: { type: 'boolean', description: 'graph: include health overlays' },
          limit: { type: 'number', description: 'Max nodes or rows per page (default 100, max 200)' },
          cursor: { type: 'string', description: 'Continuation cursor from a previous nodes/evidence/group_members page' },
          q: { type: 'string', description: 'nodes: label search text' },
          kind: { type: 'string', enum: [...TOPOLOGY_NODE_KINDS_ENUM], description: 'nodes: node kind filter' },
          deviceId: { type: 'string', description: 'nodes: only the node bound to this device UUID' },
          lifecycle: { type: 'string', enum: ['active', 'withdrawn', 'archived'], description: 'nodes: lifecycle filter (default active)' },
          health: { type: 'string', enum: ['unknown', 'healthy', 'degraded', 'failed_check'], description: 'nodes: health filter' },
          nodeId: { type: 'string', description: 'node/group_members: node UUID' },
          relationshipId: { type: 'string', description: 'relationship/evidence: link UUID' },
          token: { type: 'string', description: 'expansion: frontier token from a graph result' },
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'health: node UUIDs (max 200)' },
          relationshipIds: { type: 'array', items: { type: 'string' }, description: 'health: link UUIDs (max 400)' },
          graphRevision: { type: 'string', description: 'Optional graph revision to pin; a changed graph returns graph_revision_changed' },
        },
        required: ['action', 'siteId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!TOPOLOGY_GRAPH_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const site = await topologySite(auth, input.siteId, 'read');
      if ('error' in site) return site.error;
      const ctx = site.ctx;
      const flags = new Set<string>();
      try {
        switch (action) {
          case 'graph': {
            const graph = await getTopologyGraph(ctx, graphQuerySchema.parse(defined({
              view: input.view,
              focusNodeId: input.focusNodeId,
              hops: input.hops,
              includeHealth: input.includeHealth,
              limit: Math.min(200, (input.limit as number | undefined) ?? 100),
            })), { presentationGroups: false });
            if (typeof input.graphRevision === 'string' && input.graphRevision !== graph.revisions.graph) {
              return JSON.stringify({ error: 'Topology graph changed; reload the projection', code: 'graph_revision_changed', graphRevision: graph.revisions.graph });
            }
            return boundedJson(withSanitization(flags, projectGraph(graph, flags)));
          }
          case 'expansion': {
            const missing = requireFields(input, ['token'], action);
            if (missing) return missing;
            return boundedJson(withSanitization(flags, projectGraph(await expandTopologyGraph(ctx, String(input.token)), flags)));
          }
          case 'group_members': {
            const missing = requireFields(input, ['nodeId'], action);
            if (missing) return missing;
            const graph = await getTopologyGroupMembers(
              ctx, String(input.nodeId),
              graphQuerySchema.parse(defined({ view: input.view, limit: Math.min(200, (input.limit as number | undefined) ?? 100) })),
              typeof input.cursor === 'string' ? input.cursor : undefined,
            );
            return boundedJson(withSanitization(flags, projectGraph(graph, flags)));
          }
          case 'nodes': {
            if (typeof input.deviceId === 'string') {
              // The device filter must name a device the caller can reach (org + site + exact-device axes).
              // Lazy: aiTools.ts imports this module, so a static value import would be a cycle.
              const { verifyDeviceAccess } = await import('./aiTools');
              const access = await verifyDeviceAccess(input.deviceId, auth);
              if ('error' in access) return jsonError(access.error, 'NOT_FOUND');
            }
            const page = await listTopologyNodes(ctx, defined({
              q: input.q as string | undefined, kind: input.kind as never, deviceId: input.deviceId as string | undefined,
              lifecycle: input.lifecycle as never, health: input.health as never,
              limit: Math.min(200, (input.limit as number | undefined) ?? 100), cursor: input.cursor as string | undefined,
            }) as never) as { siteId: string; graphRevision: string; total: number; nodes: GraphNode[]; cursor: string | null };
            return boundedJson(withSanitization(flags, {
              siteId: page.siteId, graphRevision: page.graphRevision, total: page.total,
              nodes: page.nodes.map((node) => projectNode(node, flags)), cursor: page.cursor,
            }));
          }
          case 'node': {
            const missing = requireFields(input, ['nodeId'], action);
            if (missing) return missing;
            const detail = await getTopologyNode(ctx, String(input.nodeId)) as {
              siteId: string; graphRevision: string; requestedNodeId: string; node: GraphNode;
              relationships: GraphRelationship[]; relationshipFrontier: string | null; detailCoverage: unknown;
            };
            return boundedJson(withSanitization(flags, {
              siteId: detail.siteId, graphRevision: detail.graphRevision, requestedNodeId: detail.requestedNodeId,
              node: projectNode(detail.node, flags), relationships: detail.relationships.map(projectRelationship),
              relationshipFrontier: detail.relationshipFrontier, detailCoverage: detail.detailCoverage,
            }));
          }
          case 'relationship': {
            const missing = requireFields(input, ['relationshipId'], action);
            if (missing) return missing;
            const detail = await getTopologyRelationship(ctx, String(input.relationshipId)) as unknown as {
              siteId: string; graphRevision: string; relationship: GraphRelationship; physical: unknown; detailCoverage: unknown;
            };
            return boundedJson({
              siteId: detail.siteId, graphRevision: detail.graphRevision,
              relationship: projectRelationship(detail.relationship), physical: detail.physical ?? null, detailCoverage: detail.detailCoverage,
            });
          }
          case 'evidence': {
            const missing = requireFields(input, ['relationshipId'], action);
            if (missing) return missing;
            return boundedJson(await readTopologyAiLinkEvidence(ctx, {
              relationshipId: String(input.relationshipId),
              ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
              ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
            }));
          }
          case 'health': {
            const health = await getTopologyHealth(ctx, defined({
              nodeIds: (input.nodeIds as string[] | undefined) ?? [],
              relationshipIds: (input.relationshipIds as string[] | undefined) ?? [],
              graphRevision: input.graphRevision as string | undefined,
            }) as never) as {
              siteId: string; graphRevision: string; healthRevision: string; freshUntil: string | null;
              nodes: Array<{ id: string; health: GraphNode['health'] }>; relationships: Array<{ id: string; health: GraphNode['health'] }>;
            };
            return boundedJson({
              siteId: health.siteId, graphRevision: health.graphRevision, healthRevision: health.healthRevision, freshUntil: health.freshUntil,
              nodes: health.nodes.map((entry) => ({ id: entry.id, health: healthView(entry.health) })),
              relationships: health.relationships.map((entry) => ({ id: entry.id, health: healthView(entry.health) })),
            });
          }
        }
      } catch (error) {
        return topologyThrown('get_topology_graph', error);
      }
    },
  });
}
