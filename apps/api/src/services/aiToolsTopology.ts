/**
 * AI Topology Tools (M3 Task 6, amendment M3-D12): thin, bounded Tier-1 reads
 * over the same services as the REST routes in `routes/topology/history.ts`.
 * - get_interface_history (Tier 1): bounded port history for one interface
 * - get_link_health (Tier 1): current health of one link, per endpoint
 *
 * Both authorize through `requireTopologySiteAccess` (exact site, topology:read
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

/** AI-facing bound: a model never needs the UI's 1,000-bucket resolution. */
export const AI_INTERFACE_HISTORY_MAX_BUCKETS = 120;
export const AI_INTERFACE_HISTORY_MAX_SERIES = 4;

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
}
