/**
 * AI Topology Tools — thin, bounded Tier-1 reads over the same scoped services
 * as the topology REST routes.
 *
 * M4 Task 1 (#6000):
 * - get_topology: bounded graph slice (≤150 nodes, ≤250 relationships) for one view
 * - get_link_evidence: ≤100 observations/confirmations for one relationship
 * - get_diagnostic_run: one diagnostic run's states and measurements (≤30 steps)
 * M3 (M3-D12, #5999):
 * - get_interface_history: bounded port history for one interface
 * - get_link_health: current health of one link, per endpoint
 * - get_topology_impact: cautious, cited possible impact of one node/link
 *   failing — never suppresses, acknowledges or closes an alert
 * - get_recent_network_changes: ≤24 h topology change history, distinct from
 *   the older device-level get_network_changes
 * - get_topology_monitoring_status: recurring-policy arm state and telemetry
 *   arms for ONE site (arming stays human-only; no write tool exists)
 *
 * M4-D1: registered globally (domain `network`), but EVERY call is authorized
 * by `executeTool`'s topology gate (`topology/aiToolGate.ts`) against a
 * SERVER-OWNED site-pinned context — the active topology session, or a
 * one-site MCP key — plus live resource permissions, `flags.ai` and the org's
 * AI policy. A handler reads ONLY the gate-issued `context.topologyRequest`
 * and refuses without it; it never resolves a site from its own input.
 *
 * M4-D6: results are never artifact-captured (`captureExempt`) — each tool
 * returns a strictly bounded allowlisted projection instead, so no org-only
 * artifact (which carries no site provenance) can hold topology data. The
 * chat path's `compactToolResultForChat` still caps what reaches the model.
 *
 * Reads stored evidence only: no poll, probe, command, schedule or model call.
 */
import { TOPOLOGY_INTERFACE_METRIC_SERIES } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import { TopologyError, type TopologyRequestContext } from './topology/access';
import { readTopologyAiDiagnosticRun, readTopologyAiGraph, readTopologyAiLinkEvidence, topologyAiReadAliases, AI_TOPOLOGY_MAX_NODES, AI_TOPOLOGY_MAX_OBSERVATIONS } from './topology/aiRead';
import type { TopologyAiAliasContext } from './topology/aiEvidence';
import { getTopologyLinkHealth } from './topology/graph';
import { GraphReadError } from './topology/graphCursor';
import { getTopologyInterfaceHistory } from './topology/interfaceHistory';
import { getTopologyImpact } from './topology/impact';
import { getRecentTopologyChanges } from './topology/changes';
import { getTopologyMonitoringStatus } from './topology/monitoringStatus';
import { TopologyOperationError } from './topology/operationErrors';

/** AI-facing bound: a model never needs the UI's 1,000-bucket resolution. */
export const AI_INTERFACE_HISTORY_MAX_BUCKETS = 120;
export const AI_INTERFACE_HISTORY_MAX_SERIES = 4;
/** Model-sized impact projection; the full cited evidence list stays in the REST contract. */
export const AI_TOPOLOGY_IMPACT_MAX_AFFECTED = 100;
export const AI_TOPOLOGY_IMPACT_MAX_ALTERNATIVES = 50;
export const AI_TOPOLOGY_IMPACT_MAX_FAILURES = 50;
export const AI_TOPOLOGY_CHANGES_MAX_LIMIT = 100;

const jsonError = (error: string) => JSON.stringify({ error });
const UNPINNED = jsonError('Topology tools run only inside a site-pinned topology investigation');
/** Monitoring status answers every unreadable site with ONE indistinguishable message. */
const HIDDEN = jsonError('Site not found or access denied');

const SITE_PROPERTY = { type: 'string', description: 'The investigation\'s pinned site UUID (must match the session)' } as const;

type TopologyHandler = (input: Record<string, unknown>, ctx: TopologyRequestContext, aliases: TopologyAiAliasContext, auth: AuthContext) => Promise<string>;

/**
 * Wrap one topology handler: refuse without the gate-issued context, and map
 * scoped read errors to a stable envelope (never a raw driver message).
 */
function pinned(run: TopologyHandler): AiTool['handler'] {
  return async (input, auth, context?: ToolExecutionContext) => {
    const ctx = context?.topologyRequest;
    if (!ctx) return UNPINNED;
    try {
      return await run(input, ctx, topologyAiReadAliases(context?.topologyAliasScope), auth);
    } catch (error) {
      if (error instanceof GraphReadError || error instanceof TopologyError) return jsonError(error.message);
      throw error;
    }
  };
}

function topologyTool(name: string, spec: Omit<AiTool, 'tier' | 'domain' | 'deviceArgs' | 'captureExempt' | 'handler'> & { handler: TopologyHandler }): [string, AiTool] {
  return [name, {
    tier: 1, domain: 'network', deviceArgs: [], captureExempt: true,
    searchHint: spec.searchHint, definition: spec.definition, handler: pinned(spec.handler),
  }];
}

export function registerTopologyTools(aiTools: Map<string, AiTool>): void {
  const entries: Array<[string, AiTool]> = [
    topologyTool('get_topology', {
      searchHint: 'network map, topology graph, what is connected to what at this site, switches, links, gateways',
      definition: {
        name: 'get_topology',
        description: `Bounded topology graph for the investigation's site: nodes, links, evidence summary, freshness and health, at most ${AI_TOPOLOGY_MAX_NODES} nodes and 250 links, with omitted counts and coverage. Reads stored evidence only.`,
        input_schema: {
          type: 'object',
          properties: {
            site_id: SITE_PROPERTY,
            view: { type: 'string', enum: ['overview', 'physical', 'logical'], description: 'Projection (default overview)' },
            focus_node_id: { type: 'string', description: 'Optional node UUID to center a one-hop neighborhood on' },
            graph_revision: { type: 'string', description: 'Optional graph revision to pin; a changed graph returns graph_revision_changed' },
            limit: { type: 'number', description: `Max nodes (default 50, max ${AI_TOPOLOGY_MAX_NODES})` },
          },
          required: ['site_id'],
        },
      },
      handler: async (input, ctx, aliases) => JSON.stringify(await readTopologyAiGraph(ctx, {
        ...(typeof input.view === 'string' ? { view: input.view as 'overview' } : {}),
        ...(typeof input.focus_node_id === 'string' ? { focusNodeId: input.focus_node_id } : {}),
        ...(typeof input.graph_revision === 'string' ? { graphRevision: input.graph_revision } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      }, aliases)),
    }),

    topologyTool('get_link_evidence', {
      searchHint: 'why do we think these two devices are connected; LLDP/CDP/FDB observations behind a link',
      definition: {
        name: 'get_link_evidence',
        description: `Evidence behind one topology link: up to ${AI_TOPOLOGY_MAX_OBSERVATIONS} observations (method, source, observed/fresh times, current/expired/withdrawn) and source confirmations. Reads stored evidence only.`,
        input_schema: {
          type: 'object',
          properties: {
            site_id: SITE_PROPERTY,
            relationship_id: { type: 'string', description: 'Topology relationship (link) UUID' },
            limit: { type: 'number', description: `Max observations (default ${AI_TOPOLOGY_MAX_OBSERVATIONS}, max ${AI_TOPOLOGY_MAX_OBSERVATIONS})` },
            cursor: { type: 'string', description: 'Continuation cursor from a previous page' },
          },
          required: ['site_id', 'relationship_id'],
        },
      },
      handler: async (input, ctx) => JSON.stringify(await readTopologyAiLinkEvidence(ctx, {
        relationshipId: String(input.relationship_id ?? ''),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
      })),
    }),

    topologyTool('get_diagnostic_run', {
      searchHint: 'result of a gateway, DNS, internet or reachability check; did the connectivity test pass',
      definition: {
        name: 'get_diagnostic_run',
        description: 'One topology diagnostic run in the investigation\'s site: state, assessment, coverage and per-step outcome, method, latency and packet counts (at most 30 steps). Never starts a check.',
        input_schema: {
          type: 'object',
          properties: {
            site_id: SITE_PROPERTY,
            run_id: { type: 'string', description: 'Diagnostic run UUID' },
          },
          required: ['site_id', 'run_id'],
        },
      },
      handler: async (input, ctx) => JSON.stringify(await readTopologyAiDiagnosticRun(ctx, { runId: String(input.run_id ?? '') })),
    }),

    topologyTool('get_interface_history', {
      searchHint: 'switch port traffic, bandwidth, utilization, errors or discards over time for one interface',
      definition: {
        name: 'get_interface_history',
        description: 'Bounded history for one topology interface (port): bits/s, utilization, errors or discards per bucket, with units, source, epoch and gaps. Reads stored measurements only.',
        input_schema: {
          type: 'object',
          properties: {
            site_id: SITE_PROPERTY,
            interface_id: { type: 'string', description: 'Topology interface UUID' },
            series: { type: 'array', items: { type: 'string', enum: [...TOPOLOGY_INTERFACE_METRIC_SERIES] }, description: `Series to return (1-${AI_INTERFACE_HISTORY_MAX_SERIES}, no duplicates)` },
            from: { type: 'string', description: 'Range start, ISO 8601 UTC' },
            to: { type: 'string', description: 'Range end, ISO 8601 UTC (raw ≤ 7 days, any ≤ 90 days)' },
            resolution: { type: 'string', enum: ['auto', 'raw', '5m', '1h'], description: 'Bucketing resolution (default auto)' },
            max_buckets: { type: 'number', description: `Max buckets per series (default ${AI_INTERFACE_HISTORY_MAX_BUCKETS}, max ${AI_INTERFACE_HISTORY_MAX_BUCKETS})` },
          },
          required: ['site_id', 'interface_id', 'series', 'from', 'to'],
        },
      },
      handler: async (input, ctx) => {
        if (!Array.isArray(input.series) || input.series.length > AI_INTERFACE_HISTORY_MAX_SERIES) return jsonError(`series must list 1-${AI_INTERFACE_HISTORY_MAX_SERIES} names`);
        const maxBuckets = Math.min(AI_INTERFACE_HISTORY_MAX_BUCKETS, Math.max(1, Math.trunc(Number(input.max_buckets ?? AI_INTERFACE_HISTORY_MAX_BUCKETS)) || AI_INTERFACE_HISTORY_MAX_BUCKETS));
        const history = await getTopologyInterfaceHistory(ctx, String(input.interface_id ?? ''), {
          series: input.series as never, from: String(input.from ?? ''), to: String(input.to ?? ''),
          resolution: (input.resolution ?? 'auto') as never, maxBuckets,
        });
        // Compact projection: values and gaps only; per-bucket detail stays in the UI/REST contract.
        return JSON.stringify({
          interfaceId: history.interfaceId, interfaceEpoch: history.interfaceEpoch, resolution: history.resolution, interval: history.interval,
          coverage: history.coverage, reasons: history.reasons, epochs: history.epochs,
          series: history.series.map((s) => ({ name: s.name, unit: s.unit, interfaceEpoch: s.interfaceEpoch, sourceKind: s.sourceKind, producerEpoch: s.producerEpoch,
            coverage: s.coverage, points: s.points.map((p) => ({ at: p.at, value: p.value })), gaps: s.gaps })),
        });
      },
    }),

    topologyTool('get_link_health', {
      searchHint: 'is this cable, uplink or switch port link up, down, erroring or stale',
      definition: {
        name: 'get_link_health',
        description: 'Current health of one topology link: aggregated status and coverage, plus each endpoint port\'s own link state, freshness and latest rates. Reads stored evidence only.',
        input_schema: {
          type: 'object',
          properties: {
            site_id: SITE_PROPERTY,
            relationship_id: { type: 'string', description: 'Topology relationship (link) UUID' },
          },
          required: ['site_id', 'relationship_id'],
        },
      },
      handler: async (input, ctx) => JSON.stringify(await getTopologyLinkHealth(ctx, String(input.relationship_id ?? ''))),
    }),

    topologyTool('get_topology_impact', {
      searchHint: 'what else could be affected if this switch, uplink, cable or gateway fails; blast radius; downstream devices',
      definition: {
        name: 'get_topology_impact',
        description: 'Possible impact of one topology node or link failing: fresh measured failures kept apart from possibly affected entities, each with a cited path and uncertainty reasons. Never a certain downstream claim; never suppresses or closes alerts. Reads stored evidence only.',
        input_schema: {
          type: 'object',
          properties: {
            site_id: SITE_PROPERTY,
            subject_kind: { type: 'string', enum: ['node', 'relationship'], description: 'Whether the subject is a node or a relationship (link)' },
            subject_id: { type: 'string', description: 'Topology node or relationship UUID' },
            window_minutes: { type: 'number', description: 'Correlation window for measured evidence, 1-30 minutes (default 5)' },
            graph_revision: { type: 'string', description: 'Optional graph revision to pin; a changed graph returns an error instead of a silent re-read' },
          },
          required: ['site_id', 'subject_kind', 'subject_id'],
        },
      },
      handler: async (input, ctx, aliases) => {
        if (input.subject_kind !== 'node' && input.subject_kind !== 'relationship') return jsonError('subject_kind must be node or relationship');
        const minutes = Math.min(30, Math.max(1, Math.trunc(Number(input.window_minutes ?? 5)) || 5));
        const impact = await getTopologyImpact(ctx, { kind: input.subject_kind, id: String(input.subject_id ?? '') },
          { windowMinutes: minutes, ...(typeof input.graph_revision === 'string' ? { graphRevision: input.graph_revision } : {}) });
        const { evidence: _evidence, ...rest } = impact;
        const truncated = impact.potentiallyAffected.length > AI_TOPOLOGY_IMPACT_MAX_AFFECTED
          || impact.alternatives.length > AI_TOPOLOGY_IMPACT_MAX_ALTERNATIVES || impact.measuredFailures.length > AI_TOPOLOGY_IMPACT_MAX_FAILURES;
        return JSON.stringify({
          ...rest,
          measuredFailures: impact.measuredFailures.slice(0, AI_TOPOLOGY_IMPACT_MAX_FAILURES),
          // Labels are collected host names: replaced by the investigation's alias (M4 Task 2).
          potentiallyAffected: impact.potentiallyAffected.slice(0, AI_TOPOLOGY_IMPACT_MAX_AFFECTED)
            .map((entry) => ('label' in entry ? { ...entry, label: typeof entry.label === 'string' ? aliases.alias('host', entry.label) : null } : entry)),
          alternatives: impact.alternatives.slice(0, AI_TOPOLOGY_IMPACT_MAX_ALTERNATIVES),
          truncatedForModel: truncated,
        });
      },
    }),

    topologyTool('get_recent_network_changes', {
      searchHint: 'what changed on the network recently: new or lost links, attachments, routes, collection gaps, diagnostic results',
      definition: {
        name: 'get_recent_network_changes',
        description: 'Topology change history for one site in a window of at most 24 h: links observed/withdrawn, manual assertions, source restarts/revocations, collection gaps, diagnostic results and config changes, with evidence IDs. Reads stored history only.',
        input_schema: {
          type: 'object',
          properties: {
            site_id: SITE_PROPERTY,
            since: { type: 'string', description: 'Window start, ISO 8601 UTC' },
            until: { type: 'string', description: 'Window end, ISO 8601 UTC (at most 24 h after since)' },
            limit: { type: 'number', description: `Max changes per page (default 50, max ${AI_TOPOLOGY_CHANGES_MAX_LIMIT})` },
            cursor: { type: 'string', description: 'Continuation cursor from a previous page' },
          },
          required: ['site_id', 'since', 'until'],
        },
      },
      handler: async (input, ctx) => {
        const limit = Math.min(AI_TOPOLOGY_CHANGES_MAX_LIMIT, Math.max(1, Math.trunc(Number(input.limit ?? 50)) || 50));
        return JSON.stringify(await getRecentTopologyChanges(ctx, {
          since: String(input.since ?? ''), until: String(input.until ?? ''), limit,
          ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
        }));
      },
    }),

    topologyTool('get_topology_monitoring_status', {
      searchHint: 'recurring network checks, gateway/DNS/internet monitoring policy status, port telemetry arms for a site',
      definition: {
        name: 'get_topology_monitoring_status',
        description:
          'Read one site\'s recurring topology monitoring: each policy\'s armed state, blocked reason, cadence, alert thresholds and per-context failure/success streaks, plus standing port-telemetry arms. Read-only; arming is a human action in the topology UI.',
        input_schema: {
          type: 'object' as const,
          properties: {
            site_id: SITE_PROPERTY,
          },
          required: ['site_id'],
        },
      },
      handler: async (_input, ctx) => {
        try {
          return JSON.stringify(await getTopologyMonitoringStatus(ctx));
        } catch (error) {
          if (error instanceof TopologyError || error instanceof TopologyOperationError) return HIDDEN;
          throw error;
        }
      },
    }),
  ];
  for (const [name, tool] of entries) aiTools.set(name, tool);
}
