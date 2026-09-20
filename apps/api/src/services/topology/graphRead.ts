import { sql, type SQL } from 'drizzle-orm';
import type { GraphNode, GraphQuery, GraphRelationship, TopologyScope } from '@breeze/shared';
import { GraphReadError, type NodeListQuery } from './graphCursor';

export type NodeRow = {
  id: string; kind: GraphNode['kind']; role: string | null; label: string;
  lifecycle: GraphNode['lifecycle']; lastObservedAt: string | null; legacy: boolean;
  bindings: GraphNode['bindings'];
};
export type RelationshipRow = {
  id: string; kind: GraphRelationship['kind']; sourceNodeId: string; targetNodeId: string;
  directness: GraphRelationship['directness']; confidence: GraphRelationship['confidence'];
  evidenceClass: 'observed' | 'inferred' | 'manual'; lifecycle: GraphRelationship['lifecycle'];
  lastSupportedAt: string | null; supportCount: string; legacy: boolean;
  sourceInterfaceId?: string | null; targetInterfaceId?: string | null; observedFreshUntil?: string | null;
};
function column(alias: string, field: string): SQL { return sql`${sql.identifier(alias)}.${sql.identifier(field)}`; }
export function scoped(scope: TopologyScope, alias: string): SQL {
  return sql`${column(alias, 'org_id')} = ${scope.orgId}::uuid AND ${column(alias, 'site_id')} = ${scope.siteId}::uuid`;
}
export function relationshipFilter(scope: TopologyScope, view: GraphQuery['view'], alias = 'r'): SQL {
  const kind = column(alias, 'kind');
  const viewFilter = view === 'physical' ? sql`${kind} IN ('physical_link','attachment')`
    : view === 'logical' ? sql`${kind} IN ('network_member','default_route','egress_path')` : sql`true`;
  return sql`${scoped(scope, alias)} AND ${column(alias, 'deleted_at')} IS NULL
    AND ${column(alias, 'lifecycle')} = 'active' AND ${viewFilter}`;
}
export function nodeFilter(scope: TopologyScope, query: GraphQuery, alias = 'n'): SQL {
  const id = column(alias, 'id');
  const base = sql`${scoped(scope, alias)} AND ${column(alias, 'deleted_at')} IS NULL
    AND ${column(alias, 'alias_target_id')} IS NULL AND ${column(alias, 'lifecycle')} = 'active'`;
  const view = query.view === 'physical' ? sql`EXISTS (SELECT 1 FROM topology_relationships vr WHERE
    ${relationshipFilter(scope, query.view, 'vr')} AND (vr.source_node_id = ${id} OR vr.target_node_id = ${id}))` : sql`true`;
  if (!query.focusNodeId) return sql`${base} AND ${view}`;
  const focus = sql`${query.focusNodeId}::uuid`;
  const direct = sql`EXISTS (SELECT 1 FROM topology_relationships fr WHERE ${relationshipFilter(scope, query.view, 'fr')}
    AND ((fr.source_node_id = ${focus} AND fr.target_node_id = ${id}) OR (fr.target_node_id = ${focus} AND fr.source_node_id = ${id})))`;
  const twoHops = sql`EXISTS (SELECT 1 FROM topology_relationships fa JOIN topology_relationships fb
    ON (fa.source_node_id = fb.source_node_id OR fa.source_node_id = fb.target_node_id OR fa.target_node_id = fb.source_node_id OR fa.target_node_id = fb.target_node_id)
    WHERE ${relationshipFilter(scope, query.view, 'fa')} AND ${relationshipFilter(scope, query.view, 'fb')}
      AND (fa.source_node_id = ${focus} OR fa.target_node_id = ${focus}) AND (fb.source_node_id = ${id} OR fb.target_node_id = ${id}))`;
  const neighborhood = query.hops === 0 ? sql`${id} = ${focus}`
    : query.hops === 1 ? sql`(${id} = ${focus} OR ${direct})` : sql`(${id} = ${focus} OR ${direct} OR ${twoHops})`;
  return sql`${base} AND ${view} AND ${neighborhood}`;
}
export function listFilter(scope: TopologyScope, query: NodeListQuery): SQL {
  const search = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  return sql`${scoped(scope, 'n')} AND n.deleted_at IS NULL AND n.alias_target_id IS NULL
    AND n.lifecycle = ${query.lifecycle ?? 'active'}
    AND ${query.kind ? sql`n.kind = ${query.kind}` : sql`true`}
    AND ${query.deviceId ? sql`EXISTS (SELECT 1 FROM topology_node_bindings b WHERE ${scoped(scope, 'b')} AND b.node_id=n.id AND b.device_id=${query.deviceId}::uuid)` : sql`true`}
    AND ${query.assetId ? sql`EXISTS (SELECT 1 FROM topology_node_bindings b WHERE ${scoped(scope, 'b')} AND b.node_id=n.id AND b.discovered_asset_id=${query.assetId}::uuid)` : sql`true`}
    AND ${query.health && query.health !== 'unknown' ? sql`false` : sql`true`}
    AND ${search ? sql`(coalesce(n.label_override, n.attributes->>'label', n.kind || ' ' || n.id::text) ILIKE ${search} ESCAPE ${'\\'} OR n.attributes->>'prefix' ILIKE ${search} ESCAPE ${'\\'})` : sql`true`}`;
}
export function nodeColumns(scope: TopologyScope): SQL {
  return sql`n.id, n.kind, n.role, coalesce(nullif(n.label_override,''), nullif(n.attributes->>'label',''), n.kind || ' ' || n.id::text) AS label,
    n.lifecycle, n.last_observed_at AS "lastObservedAt", (n.legacy_source_id IS NOT NULL) AS legacy,
    coalesce((SELECT jsonb_agg(bounded.binding) FROM (
      SELECT jsonb_build_object('id', b.id, 'type', CASE WHEN b.device_id IS NOT NULL THEN 'device' WHEN b.discovered_asset_id IS NOT NULL THEN 'discovered_asset' ELSE 'manual_node' END,
        'referenceId', coalesce(b.device_id,b.discovered_asset_id,b.manual_node_id)) AS binding
      FROM topology_node_bindings b WHERE ${scoped(scope, 'b')} AND b.node_id = n.id ORDER BY b.id LIMIT 101
    ) bounded), '[]'::jsonb) as "bindings"`;
}
export const relationshipColumns = sql`r.id, r.kind, r.source_node_id AS "sourceNodeId", r.target_node_id AS "targetNodeId", r.directness, r.confidence,
  r.evidence_class AS "evidenceClass", r.lifecycle, r.last_supported_at AS "lastSupportedAt", r.support_count::text AS "supportCount",
  (r.legacy_source_id IS NOT NULL) AS legacy, r.source_interface_id AS "sourceInterfaceId", r.target_interface_id AS "targetInterfaceId",
  (SELECT max(CASE WHEN cs.producer_epoch=rs.producer_epoch AND cs.revoked_at IS NULL
      AND cs.published_digest=cs.content_digest AND rs.content_digest=cs.published_digest AND cs.last_outcome IN ('complete','partial')
    THEN greatest(rs.fresh_until,cs.fresh_until) ELSE rs.fresh_until END)
   FROM topology_relationship_support rs JOIN topology_collection_sources cs ON cs.id=rs.source_id AND cs.org_id=rs.org_id AND cs.site_id=rs.site_id
   WHERE rs.org_id=r.org_id AND rs.site_id=r.site_id AND rs.relationship_id=r.id AND rs.lifecycle='active') AS "observedFreshUntil"`;
export function unknownHealth(scope: 'node' | 'relationship') {
  return { status: 'unknown' as const, coverage: 'unmonitored' as const, scope, originNodeId: null, resultId: null,
    freshness: 'unknown' as const, reasons: [{ code: 'monitoring_unavailable', message: 'Topology monitoring is not available in this milestone.' }] };
}
function timestamp(value: string | Date | null): string | null { return value ? new Date(value).toISOString() : null; }
export function presentNode(row: NodeRow, canEdit: boolean, health?: GraphNode['health']): GraphNode {
  if (row.bindings.length > 100) throw new GraphReadError('topology_binding_limit', 503, 'Node binding detail exceeds the supported projection limit');
  return { id: row.id, kind: row.kind, role: row.role?.trim() || null, label: row.label.trim().slice(0, 255) || `${row.kind} ${row.id}`, bindings: row.bindings,
    lifecycle: row.lifecycle, freshness: 'unknown', evidence: { classes: row.kind === 'manual' ? ['manual'] : [],
      methods: row.legacy ? ['legacy'] : [], count: row.legacy || row.kind === 'manual' ? '1' : '0', lastObservedAt: timestamp(row.lastObservedAt) },
    health: health ?? unknownHealth('node'), availableActions: canEdit && row.kind === 'manual' ? ['edit', 'delete'] : [] };
}
export function presentRelationship(row: RelationshipRow, canEdit: boolean, health?: GraphRelationship['health']): GraphRelationship {
  return { id: row.id, kind: row.kind, directionality: row.kind === 'physical_link' ? 'undirected' : 'directed',
    sourceNodeId: row.sourceNodeId, targetNodeId: row.targetNodeId, sourceInterfaceId: row.sourceInterfaceId ?? null, targetInterfaceId: row.targetInterfaceId ?? null,
    meaning: row.kind, directness: row.directness, confidence: row.confidence, lifecycle: row.lifecycle,
    evidence: { classes: [row.evidenceClass], methods: row.legacy ? ['legacy'] : row.evidenceClass === 'manual' ? ['manual'] : [],
      count: row.supportCount, lastObservedAt: timestamp(row.lastSupportedAt) }, freshness: row.observedFreshUntil ? (Date.parse(row.observedFreshUntil)>Date.now()?'fresh':'stale') : 'unknown', health: health ?? unknownHealth('relationship'),
    excluded: false, availableActions: canEdit && row.evidenceClass === 'manual' ? ['edit', 'delete'] : [] };
}
export function safeCount(value: string | number | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new GraphReadError('topology_count_limit', 503, 'Topology count exceeds supported precision');
  return count;
}
export const missingSubject = () => new GraphReadError('topology_subject_not_found', 404, 'Topology subject not found');
