/**
 * AI Topology Tools (M3 Task 6, amendment M3-D12): thin, bounded Tier-1 reads
 * over the same services as the REST routes in `routes/topology/history.ts`.
 * - get_interface_history (Tier 1): bounded port history for one interface
 * - get_link_health (Tier 1): current health of one link, per endpoint
 * - get_topology_impact (Tier 1, M3 Task 10): cautious, cited possible impact
 *   of one node/link failing — measured failures kept apart from possible
 *   dependencies; never suppresses, acknowledges or closes an alert
 * - get_recent_network_changes (Tier 1, M3 Task 10): bounded ≤ 24 h topology
 *   change history (attachment/route/source/gap/measurement), distinct from
 *   the older device-level get_network_changes
 * - get_topology_monitoring_status (Tier 1, M3-D12 #5999): recurring-policy
 *   arm state, thresholds and per-context streaks plus standing telemetry arms
 *   for ONE site, under the same site access check as
 *   GET /topology/sites/:siteId/monitoring. Arming and scheduling are
 *   human-only by design (the operations spec forbids AI scheduling), so no
 *   write tool exists here.
 *
 * All authorize through `requireTopologySiteAccess` (exact site, topology:read
 * + devices:read), read stored measurements only, and never poll, probe or
 * queue a command. M4-D1 will additionally pin invocation to a server-owned
 * site-bound session; until then the site is an explicit argument and is
 * verified against the caller's live site/org ceilings like any REST read.
 */
import { z } from 'zod';
import { TOPOLOGY_INTERFACE_METRIC_SERIES } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { getUserPermissions } from './permissions';
import { requireTopologySiteAccess, TopologyError, type TopologyRequestContext } from './topology/access';
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
const uuid = z.string().guid();

async function topologyContext(auth: AuthContext, siteId: unknown): Promise<TopologyRequestContext | string> {
  const parsed = uuid.safeParse(siteId);
  if (!parsed.success) return 'Topology site not found';
  const permissions = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined, orgId: auth.orgId ?? undefined, scope: auth.scope,
  });
  if (!permissions) return 'Topology permission denied';
  try {
    return await requireTopologySiteAccess(auth, permissions, parsed.data, 'read');
  } catch (error) {
    if (error instanceof TopologyError) return error.message;
    throw error;
  }
}

/**
 * Monitoring status answers every unreadable site with ONE indistinguishable
 * message (no permission, not found, and operation errors all collapse).
 */
const HIDDEN = JSON.stringify({ error: 'Site not found or access denied' });

export async function topologyMonitoringStatusTool(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const siteId = typeof input.site_id === 'string' ? input.site_id : '';
  if (!uuid.safeParse(siteId).success) return JSON.stringify({ error: 'site_id must be a site UUID' });
  const permissions = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  });
  if (!permissions) return HIDDEN;
  try {
    const ctx = await requireTopologySiteAccess(auth, permissions, siteId, 'read');
    return JSON.stringify(await getTopologyMonitoringStatus(ctx));
  } catch (error) {
    if (error instanceof TopologyError || error instanceof TopologyOperationError) return HIDDEN;
    throw error;
  }
}

async function guarded(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GraphReadError) return jsonError(error.message);
    throw error;
  }
}

export function registerTopologyTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_interface_history', {
    tier: 1,
    domain: 'network',
    searchHint: 'switch port traffic, bandwidth, utilization, errors or discards over time for one interface',
    deviceArgs: [],
    definition: {
      name: 'get_interface_history',
      description: 'Bounded history for one topology interface (port): bits/s, utilization, errors or discards per bucket, with units, source, epoch and gaps. Reads stored measurements only.',
      input_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site UUID that owns the topology' },
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
    handler: (input, auth) => guarded(async () => {
      if (!Array.isArray(input.series) || input.series.length > AI_INTERFACE_HISTORY_MAX_SERIES) return jsonError(`series must list 1-${AI_INTERFACE_HISTORY_MAX_SERIES} names`);
      const ctx = await topologyContext(auth, input.site_id);
      if (typeof ctx === 'string') return jsonError(ctx);
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
    }),
  });

  aiTools.set('get_link_health', {
    tier: 1,
    domain: 'network',
    searchHint: 'is this cable, uplink or switch port link up, down, erroring or stale',
    deviceArgs: [],
    definition: {
      name: 'get_link_health',
      description: 'Current health of one topology link: aggregated status and coverage, plus each endpoint port\'s own link state, freshness and latest rates. Reads stored evidence only.',
      input_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site UUID that owns the topology' },
          relationship_id: { type: 'string', description: 'Topology relationship (link) UUID' },
        },
        required: ['site_id', 'relationship_id'],
      },
    },
    handler: (input, auth) => guarded(async () => {
      const ctx = await topologyContext(auth, input.site_id);
      if (typeof ctx === 'string') return jsonError(ctx);
      return JSON.stringify(await getTopologyLinkHealth(ctx, String(input.relationship_id ?? '')));
    }),
  });

  aiTools.set('get_topology_impact', {
    tier: 1,
    domain: 'network',
    searchHint: 'what else could be affected if this switch, uplink, cable or gateway fails; blast radius; downstream devices',
    deviceArgs: [],
    definition: {
      name: 'get_topology_impact',
      description: 'Possible impact of one topology node or link failing: fresh measured failures kept apart from possibly affected entities, each with a cited path and uncertainty reasons. Never a certain downstream claim; never suppresses or closes alerts. Reads stored evidence only.',
      input_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site UUID that owns the topology' },
          subject_kind: { type: 'string', enum: ['node', 'relationship'], description: 'Whether the subject is a node or a relationship (link)' },
          subject_id: { type: 'string', description: 'Topology node or relationship UUID' },
          window_minutes: { type: 'number', description: 'Correlation window for measured evidence, 1-30 minutes (default 5)' },
          graph_revision: { type: 'string', description: 'Optional graph revision to pin; a changed graph returns an error instead of a silent re-read' },
        },
        required: ['site_id', 'subject_kind', 'subject_id'],
      },
    },
    handler: (input, auth) => guarded(async () => {
      if (input.subject_kind !== 'node' && input.subject_kind !== 'relationship') return jsonError('subject_kind must be node or relationship');
      const ctx = await topologyContext(auth, input.site_id);
      if (typeof ctx === 'string') return jsonError(ctx);
      const minutes = Math.min(30, Math.max(1, Math.trunc(Number(input.window_minutes ?? 5)) || 5));
      const impact = await getTopologyImpact(ctx, { kind: input.subject_kind, id: String(input.subject_id ?? '') },
        { windowMinutes: minutes, ...(typeof input.graph_revision === 'string' ? { graphRevision: input.graph_revision } : {}) });
      const { evidence: _evidence, ...rest } = impact;
      const truncated = impact.potentiallyAffected.length > AI_TOPOLOGY_IMPACT_MAX_AFFECTED
        || impact.alternatives.length > AI_TOPOLOGY_IMPACT_MAX_ALTERNATIVES || impact.measuredFailures.length > AI_TOPOLOGY_IMPACT_MAX_FAILURES;
      return JSON.stringify({
        ...rest,
        measuredFailures: impact.measuredFailures.slice(0, AI_TOPOLOGY_IMPACT_MAX_FAILURES),
        potentiallyAffected: impact.potentiallyAffected.slice(0, AI_TOPOLOGY_IMPACT_MAX_AFFECTED),
        alternatives: impact.alternatives.slice(0, AI_TOPOLOGY_IMPACT_MAX_ALTERNATIVES),
        truncatedForModel: truncated,
      });
    }),
  });

  aiTools.set('get_recent_network_changes', {
    tier: 1,
    domain: 'network',
    searchHint: 'what changed on the network recently: new or lost links, attachments, routes, collection gaps, diagnostic results',
    deviceArgs: [],
    definition: {
      name: 'get_recent_network_changes',
      description: 'Topology change history for one site in a window of at most 24 h: links observed/withdrawn, manual assertions, source restarts/revocations, collection gaps, diagnostic results and config changes, with evidence IDs. Reads stored history only.',
      input_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site UUID that owns the topology' },
          since: { type: 'string', description: 'Window start, ISO 8601 UTC' },
          until: { type: 'string', description: 'Window end, ISO 8601 UTC (at most 24 h after since)' },
          limit: { type: 'number', description: `Max changes per page (default 50, max ${AI_TOPOLOGY_CHANGES_MAX_LIMIT})` },
          cursor: { type: 'string', description: 'Continuation cursor from a previous page' },
        },
        required: ['site_id', 'since', 'until'],
      },
    },
    handler: (input, auth) => guarded(async () => {
      const ctx = await topologyContext(auth, input.site_id);
      if (typeof ctx === 'string') return jsonError(ctx);
      const limit = Math.min(AI_TOPOLOGY_CHANGES_MAX_LIMIT, Math.max(1, Math.trunc(Number(input.limit ?? 50)) || 50));
      return JSON.stringify(await getRecentTopologyChanges(ctx, {
        since: String(input.since ?? ''), until: String(input.until ?? ''), limit,
        ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
      }));
    }),
  });

  aiTools.set('get_topology_monitoring_status', {
    tier: 1,
    domain: 'network',
    deviceArgs: [],
    searchHint: 'recurring network checks, gateway/DNS/internet monitoring policy status, port telemetry arms for a site',
    definition: {
      name: 'get_topology_monitoring_status',
      description:
        'Read one site\'s recurring topology monitoring: each policy\'s armed state, blocked reason, cadence, alert thresholds and per-context failure/success streaks, plus standing port-telemetry arms. Read-only; arming is a human action in the topology UI.',
      input_schema: {
        type: 'object' as const,
        properties: {
          site_id: { type: 'string', description: 'Site UUID' },
        },
        required: ['site_id'],
      },
    },
    handler: (input, auth) => topologyMonitoringStatusTool(input, auth),
  });
}
