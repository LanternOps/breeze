import { sql, type SQL } from 'drizzle-orm';
import { EVIDENCE_CLASSES, OBSERVATION_METHODS, type GraphNode, type GraphQuery, type GraphRelationship, type ObservationMethod, type TopologyScope } from '@breeze/shared';
import { GraphReadError, type NodeListQuery } from './graphCursor';

/**
 * What one read may expose (M2 D9/D15.4, D17). `physical` is the deployed
 * physical capability (materialization && flag): when off, relationships
 * produced by physical collectors — and endpoint nodes that exist only because
 * of them — are hidden from every graph read, count, neighborhood and frontier,
 * while canonical publication keeps running. `excluded` is the active per-view
 * exclusion set of THIS view only; it never applies to detail/evidence reads.
 */
export type ReadExposure = { physical: boolean; excluded: ReadonlySet<string> };
/** Methods written by physical collectors (physicalProjector/unifi). Legacy and manual rows are not gated. */
const PHYSICAL_COLLECTOR_METHODS = sql.raw(`'lldp','cdp','fdb','unifi'`);
/** Node identity namespaces only a physical collector creates (physicalIdentity/unifiAdapter). */
const PHYSICAL_ONLY_NODE_KEY = '^(lldp-chassis|cdp-device|mac-endpoint|physical-target|unifi):';

export type NodeRow = {
  id: string; kind: GraphNode['kind']; role: string | null; label: string;
  lifecycle: GraphNode['lifecycle']; lastObservedAt: string | null; legacy: boolean;
  bindings: GraphNode['bindings'];
  /** Live inventory facts through the node's first device (else asset) binding; null/absent when unbound. */
  inventory?: NonNullable<GraphNode['inventory']> | null;
  /** Active, exposure-permitted incident relationships: count, latest support expiry, latest observation, distinct (kind, method, legacy, class). */
  support?: { count: string | number; freshUntil: string | null; observedAt?: string | null; kinds: [string, string | null, boolean, string][] } | null;
};
export type RelationshipRow = {
  id: string; kind: GraphRelationship['kind']; sourceNodeId: string; targetNodeId: string;
  directness: GraphRelationship['directness']; confidence: GraphRelationship['confidence'];
  evidenceClass: 'observed' | 'inferred' | 'manual'; lifecycle: GraphRelationship['lifecycle'];
  lastSupportedAt: string | null; supportCount: string; legacy: boolean;
  sourceInterfaceId?: string | null; targetInterfaceId?: string | null; observedFreshUntil?: string | null;
  /** attributes.method of physical/manual rows (lldp, cdp, fdb, unifi, …). */
  method?: string | null;
};
function column(alias: string, field: string): SQL { return sql`${sql.identifier(alias)}.${sql.identifier(field)}`; }
export function scoped(scope: TopologyScope, alias: string): SQL {
  return sql`${column(alias, 'org_id')} = ${scope.orgId}::uuid AND ${column(alias, 'site_id')} = ${scope.siteId}::uuid`;
}
/** Relationship exposure: the physical gate plus this view's exclusions. */
export function relationshipExposure(exposure: Pick<ReadExposure, 'physical'> & Partial<Pick<ReadExposure, 'excluded'>>, alias = 'r'): SQL {
  const parts: SQL[] = [];
  if (!exposure.physical) {
    parts.push(sql`NOT (${column(alias, 'kind')} IN ('physical_link','attachment')
      AND coalesce(${column(alias, 'attributes')}->>'method', '') IN (${PHYSICAL_COLLECTOR_METHODS}))`);
  }
  if (exposure.excluded?.size) {
    // One array parameter per use, however many exclusions the view has.
    parts.push(sql`NOT (${column(alias, 'id')} = ANY(${`{${[...exposure.excluded].join(',')}}`}::uuid[]))`);
  }
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
}
/** Node exposure: with physical off, an unbound node created only by a physical collector is hidden. */
export function nodeExposure(scope: TopologyScope, exposure: Pick<ReadExposure, 'physical'>, alias = 'n'): SQL {
  if (exposure.physical) return sql`true`;
  return sql`NOT (coalesce(${column(alias, 'identity_material')}->>'sourceKey', '') ~ ${PHYSICAL_ONLY_NODE_KEY}
    AND NOT EXISTS (SELECT 1 FROM topology_node_bindings xb WHERE ${scoped(scope, 'xb')} AND xb.node_id = ${column(alias, 'id')}))`;
}
export function relationshipFilter(scope: TopologyScope, view: GraphQuery['view'], alias: string, exposure: ReadExposure): SQL {
  const kind = column(alias, 'kind');
  const viewFilter = view === 'physical' ? sql`${kind} IN ('physical_link','attachment')`
    : view === 'logical' ? sql`${kind} IN ('network_member','default_route','egress_path')` : sql`true`;
  return sql`${scoped(scope, alias)} AND ${column(alias, 'deleted_at')} IS NULL
    AND ${column(alias, 'lifecycle')} = 'active' AND ${viewFilter} AND ${relationshipExposure(exposure, alias)}`;
}
export function nodeFilter(scope: TopologyScope, query: GraphQuery, alias: string, exposure: ReadExposure): SQL {
  const id = column(alias, 'id');
  const base = sql`${scoped(scope, alias)} AND ${column(alias, 'deleted_at')} IS NULL
    AND ${column(alias, 'alias_target_id')} IS NULL AND ${column(alias, 'lifecycle')} = 'active' AND ${nodeExposure(scope, exposure, alias)}`;
  const view = query.view === 'physical' ? sql`EXISTS (SELECT 1 FROM topology_relationships vr WHERE
    ${relationshipFilter(scope, query.view, 'vr', exposure)} AND (vr.source_node_id = ${id} OR vr.target_node_id = ${id}))` : sql`true`;
  if (!query.focusNodeId) return sql`${base} AND ${view}`;
  const focus = sql`${query.focusNodeId}::uuid`;
  const direct = sql`EXISTS (SELECT 1 FROM topology_relationships fr WHERE ${relationshipFilter(scope, query.view, 'fr', exposure)}
    AND ((fr.source_node_id = ${focus} AND fr.target_node_id = ${id}) OR (fr.target_node_id = ${focus} AND fr.source_node_id = ${id})))`;
  const twoHops = sql`EXISTS (SELECT 1 FROM topology_relationships fa JOIN topology_relationships fb
    ON (fa.source_node_id = fb.source_node_id OR fa.source_node_id = fb.target_node_id OR fa.target_node_id = fb.source_node_id OR fa.target_node_id = fb.target_node_id)
    WHERE ${relationshipFilter(scope, query.view, 'fa', exposure)} AND ${relationshipFilter(scope, query.view, 'fb', exposure)}
      AND (fa.source_node_id = ${focus} OR fa.target_node_id = ${focus}) AND (fb.source_node_id = ${id} OR fb.target_node_id = ${id}))`;
  const neighborhood = query.hops === 0 ? sql`${id} = ${focus}`
    : query.hops === 1 ? sql`(${id} = ${focus} OR ${direct})` : sql`(${id} = ${focus} OR ${direct} OR ${twoHops})`;
  return sql`${base} AND ${view} AND ${neighborhood}`;
}
export function listFilter(scope: TopologyScope, query: NodeListQuery, exposure: Pick<ReadExposure, 'physical'>): SQL {
  const search = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  return sql`${scoped(scope, 'n')} AND n.deleted_at IS NULL AND n.alias_target_id IS NULL AND ${nodeExposure(scope, exposure, 'n')}
    AND n.lifecycle = ${query.lifecycle ?? 'active'}
    AND ${query.kind ? sql`n.kind = ${query.kind}` : sql`true`}
    AND ${query.deviceId ? sql`EXISTS (SELECT 1 FROM topology_node_bindings b WHERE ${scoped(scope, 'b')} AND b.node_id=n.id AND b.device_id=${query.deviceId}::uuid)` : sql`true`}
    AND ${query.assetId ? sql`EXISTS (SELECT 1 FROM topology_node_bindings b WHERE ${scoped(scope, 'b')} AND b.node_id=n.id AND b.discovered_asset_id=${query.assetId}::uuid)` : sql`true`}
    AND ${query.health && query.health !== 'unknown' ? sql`false` : sql`true`}
    AND ${search ? nodeSearch(search) : sql`true`}`;
}
/** Inventory joins for a binding alias; every subquery below is scoped by node `n`'s own org/site (no parameters, no caller joins). */
const deviceOf = (b: string, d: string) => sql.raw(`devices ${d} ON ${d}.id = ${b}.device_id AND ${d}.org_id = ${b}.org_id`);
const assetOf = (b: string, a: string) => sql.raw(`discovered_assets ${a} ON ${a}.id = ${b}.discovered_asset_id AND ${a}.org_id = ${b}.org_id`);
const networkOf = (b: string, dn: string) => sql.raw(`device_network ${dn} ON ${dn}.device_id = ${b}.device_id AND ${dn}.org_id = ${b}.org_id`);
/** device_network.ip_address is free text: drop any mask so the address reads like an asset's host(). */
const deviceAddress = (dn: string) => sql.raw(`nullif(btrim(split_part(${dn}.ip_address, '/', 1)), '')`);
const primaryNetworkOrder = (dn: string) => sql.raw(`${dn}.is_primary DESC, (${dn}.ip_type = 'ipv4') DESC, ${dn}.interface_name, ${dn}.id`);
/**
 * Display label of node alias `n` (grouped overview §2): the operator's override, then the
 * LIVE device/asset name through its binding (legacy labels were a one-time copy), the
 * collected label, an inventory address or MAC, and only then a generic fallback.
 * Self-contained scalar subqueries scoped by `n`'s org/site, so impact.ts and
 * relationshipDetail.ts embed it with no join changes. coalesce() stops at the first hit.
 */
export const nodeLabelSql = sql`coalesce(
  nullif(btrim(n.label_override), ''),
  (SELECT coalesce(nullif(btrim(ld.display_name), ''), nullif(btrim(ld.hostname), '')) FROM topology_node_bindings lb JOIN ${deviceOf('lb', 'ld')}
    WHERE lb.org_id = n.org_id AND lb.site_id = n.site_id AND lb.node_id = n.id ORDER BY lb.id LIMIT 1),
  (SELECT coalesce(nullif(btrim(la.label), ''), nullif(btrim(la.hostname), ''), nullif(btrim(la.netbios_name), ''))
    FROM topology_node_bindings lb JOIN ${assetOf('lb', 'la')} WHERE lb.org_id = n.org_id AND lb.site_id = n.site_id AND lb.node_id = n.id ORDER BY lb.id LIMIT 1),
  nullif(btrim(n.attributes->>'label'), ''),
  (SELECT host(la.ip_address) FROM topology_node_bindings lb JOIN ${assetOf('lb', 'la')}
    WHERE lb.org_id = n.org_id AND lb.site_id = n.site_id AND lb.node_id = n.id AND la.ip_address IS NOT NULL ORDER BY lb.id LIMIT 1),
  (SELECT ${deviceAddress('ldn')} FROM topology_node_bindings lb JOIN ${networkOf('lb', 'ldn')}
    WHERE lb.org_id = n.org_id AND lb.site_id = n.site_id AND lb.node_id = n.id AND ${deviceAddress('ldn')} IS NOT NULL ORDER BY lb.id, ${primaryNetworkOrder('ldn')} LIMIT 1),
  (SELECT nullif(btrim(la.mac_address), '') FROM topology_node_bindings lb JOIN ${assetOf('lb', 'la')}
    WHERE lb.org_id = n.org_id AND lb.site_id = n.site_id AND lb.node_id = n.id AND nullif(btrim(la.mac_address), '') IS NOT NULL ORDER BY lb.id LIMIT 1),
  (SELECT nullif(btrim(ldn.mac_address), '') FROM topology_node_bindings lb JOIN ${networkOf('lb', 'ldn')}
    WHERE lb.org_id = n.org_id AND lb.site_id = n.site_id AND lb.node_id = n.id AND nullif(btrim(ldn.mac_address), '') IS NOT NULL ORDER BY lb.id, ${primaryNetworkOrder('ldn')} LIMIT 1),
  CASE n.kind WHEN 'endpoint' THEN 'Unidentified device' ELSE n.kind END)`;
/** Search matches the display label, a network prefix, or any inventory IP/MAC — independently of which one became the label. */
function nodeSearch(search: string): SQL {
  const like = sql`ILIKE ${search} ESCAPE ${'\\'}`;
  return sql`(${nodeLabelSql} ${like} OR n.attributes->>'prefix' ${like}
    OR EXISTS (SELECT 1 FROM topology_node_bindings sb JOIN ${assetOf('sb', 'sa')} WHERE sb.org_id = n.org_id AND sb.site_id = n.site_id AND sb.node_id = n.id
      AND (host(sa.ip_address) ${like} OR sa.mac_address ${like}))
    OR EXISTS (SELECT 1 FROM topology_node_bindings sb JOIN ${networkOf('sb', 'sdn')} WHERE sb.org_id = n.org_id AND sb.site_id = n.site_id AND sb.node_id = n.id
      AND (sdn.ip_address ${like} OR sdn.mac_address ${like})))`;
}
const isoUtc = (column: string) => sql.raw(`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
/**
 * Scan presence of discovered asset `a` (#7879). `is_online` is sticky: the disappeared
 * sweep only ever flips APPROVED assets, so a pending asset that left the network reads
 * "online" forever. Presence is instead whether the asset appeared in the latest completed
 * scan of the profile that last saw it (`last_job_id` is always the newest job that saw
 * it, so a later completed job of that profile is one that did not). Per profile, because
 * a site's profiles scan different subnets. No scan of the asset at all is `unknown`.
 * The latest-completion map is uncorrelated with the node, so Postgres reads
 * discovery_jobs once per statement (an InitPlan), not once per node.
 */
function assetScanPresenceSql(scope: TopologyScope): SQL {
  const latestCompleted = sql`(SELECT coalesce(jsonb_object_agg(lj.profile_id::text, lj.completed_at), '{}'::jsonb) FROM (
      SELECT dj.profile_id, max(dj.completed_at) AS completed_at FROM discovery_jobs dj
      WHERE dj.org_id = ${scope.orgId}::uuid AND dj.site_id = ${scope.siteId}::uuid AND dj.status = 'completed' AND dj.completed_at IS NOT NULL
      GROUP BY dj.profile_id) lj)`;
  return sql`coalesce((SELECT CASE
      WHEN coalesce(sj.completed_at, sj.started_at, sj.created_at) >= coalesce((${latestCompleted} ->> sj.profile_id::text)::timestamp, '-infinity'::timestamp)
      THEN 'online' ELSE 'offline' END
    FROM discovery_jobs sj WHERE sj.id = a.last_job_id AND sj.org_id = a.org_id), 'unknown')`;
}
/**
 * Live inventory of node `n` (grouped overview §1): the first device binding, else the
 * first discovered-asset binding. Presence is agent/scan reachability, never health.
 * Topology `read` already requires devices:read (permissionPairs.ts), so nothing new is disclosed.
 */
const nodeInventorySql = (scope: TopologyScope) => sql`coalesce(
  (SELECT jsonb_build_object('source', 'device', 'name', coalesce(nullif(btrim(d.display_name), ''), d.hostname),
      'addresses', coalesce((SELECT jsonb_agg(x.ip ORDER BY x.primary_rank, x.v4_rank, x.ip) FROM (
        SELECT ${deviceAddress('dn')} AS ip, min(CASE WHEN dn.is_primary THEN 0 ELSE 1 END) AS primary_rank, min(CASE WHEN dn.ip_type = 'ipv4' THEN 0 ELSE 1 END) AS v4_rank
        FROM device_network dn WHERE dn.device_id = d.id AND dn.org_id = d.org_id AND ${deviceAddress('dn')} IS NOT NULL
        GROUP BY 1 ORDER BY 2, 3, 1 LIMIT 8) x), '[]'::jsonb),
      'mac', (SELECT nullif(btrim(dn.mac_address), '') FROM device_network dn WHERE dn.device_id = d.id AND dn.org_id = d.org_id
        AND nullif(btrim(dn.mac_address), '') IS NOT NULL ORDER BY ${primaryNetworkOrder('dn')} LIMIT 1),
      'vendor', NULL::text, 'model', NULL::text,
      'os', nullif(btrim(concat_ws(' ', d.os_type::text, d.os_version)), ''),
      'type', nullif(nullif(btrim(d.device_role), ''), 'unknown'),
      'presence', jsonb_build_object(
        'state', CASE WHEN d.status = 'online' THEN 'online' WHEN d.status IN ('offline', 'decommissioned', 'quarantined') THEN 'offline' ELSE 'unknown' END,
        'source', 'agent', 'agentStatus', d.status::text, 'lastSeenAt', ${isoUtc('d.last_seen_at')}))
    FROM topology_node_bindings ib JOIN ${deviceOf('ib', 'd')}
    WHERE ib.org_id = n.org_id AND ib.site_id = n.site_id AND ib.node_id = n.id ORDER BY ib.id LIMIT 1),
  (SELECT jsonb_build_object('source', 'discovered_asset',
      'name', coalesce(nullif(btrim(a.label), ''), nullif(btrim(a.hostname), ''), nullif(btrim(a.netbios_name), '')),
      'addresses', CASE WHEN a.ip_address IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(host(a.ip_address)) END,
      'mac', nullif(btrim(a.mac_address), ''), 'vendor', nullif(btrim(a.manufacturer), ''), 'model', nullif(btrim(a.model), ''),
      'os', NULL::text, 'type', nullif(a.asset_type::text, 'unknown'),
      'presence', jsonb_build_object('state', ${assetScanPresenceSql(scope)}, 'source', 'scan',
        'agentStatus', NULL::text, 'lastSeenAt', ${isoUtc('a.last_seen_at')}))
    FROM topology_node_bindings ib JOIN ${assetOf('ib', 'a')}
    WHERE ib.org_id = n.org_id AND ib.site_id = n.site_id AND ib.node_id = n.id ORDER BY ib.id LIMIT 1))`;
/**
 * Latest support expiry of relationship `alias`, honouring a still-published source
 * digest (the same rule queueTopologyAging archives by). Shared by relationship and
 * node freshness and by the presentation-group read.
 */
export function observedFreshUntilSql(alias: string): SQL {
  return supportRollupSql(alias, sql`greatest(rs.fresh_until,cs.fresh_until)`, sql`rs.fresh_until`);
}
/**
 * Latest observation of relationship `alias` under the same rule (#7879): a source that
 * re-captured unchanged, still-published content confirmed the relationship at
 * `confirmed_through_at`, even though no support row was rewritten. Without this a
 * relationship that is fresh reads as last observed at its last content change.
 */
export function observedAtSql(alias: string): SQL {
  return supportRollupSql(alias, sql`greatest(rs.last_positive_at,cs.confirmed_through_at)`, sql`rs.last_positive_at`);
}
function supportRollupSql(alias: string, confirmed: SQL, own: SQL): SQL {
  const r = sql.identifier(alias);
  return sql`(SELECT max(CASE WHEN cs.producer_epoch=rs.producer_epoch AND cs.revoked_at IS NULL
      AND cs.published_digest=cs.content_digest AND rs.content_digest=cs.published_digest AND cs.last_outcome IN ('complete','partial')
    THEN ${confirmed} ELSE ${own} END)
   FROM topology_relationship_support rs JOIN topology_collection_sources cs ON cs.id=rs.source_id AND cs.org_id=rs.org_id AND cs.site_id=rs.site_id
   WHERE rs.org_id=${r}.org_id AND rs.site_id=${r}.site_id AND rs.relationship_id=${r}.id AND rs.lifecycle='active')`;
}
/**
 * Node freshness/evidence (§3) from ALL active incident relationships this read may expose — never the bounded edge page.
 * `observedAt` is the latest of their observations (#7879): an agent node has no node-level
 * observation of its own, so its routes and memberships ARE its evidence.
 */
function nodeSupportSql(exposure: NodeColumnsExposure): SQL {
  return sql`(SELECT jsonb_build_object('count', count(*)::text, 'freshUntil', max(s.fresh_until), 'observedAt', max(s.observed_at),
      'kinds', coalesce(jsonb_agg(DISTINCT jsonb_build_array(s.kind, s.method, s.legacy, s.evidence_class)), '[]'::jsonb))
    FROM (SELECT ir.kind, ir.attributes->>'method' AS method, (ir.legacy_source_id IS NOT NULL) AS legacy, ir.evidence_class,
        ${observedFreshUntilSql('ir')} AS fresh_until, greatest(ir.last_supported_at, ${observedAtSql('ir')}) AS observed_at
      FROM topology_relationships ir WHERE ir.org_id = n.org_id AND ir.site_id = n.site_id AND ir.deleted_at IS NULL AND ir.lifecycle = 'active'
        AND (ir.source_node_id = n.id OR ir.target_node_id = n.id) AND ${relationshipExposure(exposure, 'ir')}) s)`;
}
type NodeColumnsExposure = Pick<ReadExposure, 'physical'> & Partial<Pick<ReadExposure, 'excluded'>>;
export function nodeColumns(scope: TopologyScope, exposure: NodeColumnsExposure): SQL {
  return sql`n.id, n.kind, n.role, ${nodeLabelSql} AS label,
    ${nodeInventorySql(scope)} as "inventory", ${nodeSupportSql(exposure)} as "support",
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
  r.attributes->>'method' AS method, ${observedFreshUntilSql('r')} AS "observedFreshUntil"`;
export function unknownHealth(scope: 'node' | 'relationship') {
  return { status: 'unknown' as const, coverage: 'unmonitored' as const, scope, originNodeId: null, resultId: null,
    freshness: 'unknown' as const, reasons: [{ code: 'monitoring_unavailable', message: 'Topology monitoring is not available in this milestone.' }] };
}
function timestamp(value: string | Date | null): string | null { return value ? new Date(value).toISOString() : null; }
const latest = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : a ?? b);
const freshnessOf = (freshUntil: string | null | undefined): GraphNode['freshness'] =>
  freshUntil ? (Date.parse(freshUntil) > Date.now() ? 'fresh' : 'stale') : 'unknown';
const text = (value: string | null | undefined, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
function presentInventory(value: NonNullable<NodeRow['inventory']>): NonNullable<GraphNode['inventory']> {
  const addresses = [...new Set((value.addresses ?? []).filter((address): address is string => typeof address === 'string' && !!address.trim() && address.length <= 64))].slice(0, 8);
  const lastSeenAt = value.presence?.lastSeenAt && !Number.isNaN(Date.parse(value.presence.lastSeenAt)) ? new Date(value.presence.lastSeenAt).toISOString() : null;
  return { source: value.source, name: text(value.name, 255), addresses, mac: text(value.mac, 64), vendor: text(value.vendor, 255), model: text(value.model, 255),
    os: text(value.os, 255), type: text(value.type, 64),
    presence: { state: value.presence?.state ?? 'unknown', source: value.presence?.source ?? (value.source === 'device' ? 'agent' : 'scan'),
      agentStatus: text(value.presence?.agentStatus, 32), lastSeenAt } };
}
export function presentNode(row: NodeRow, canEdit: boolean, health?: GraphNode['health']): GraphNode {
  if (row.bindings.length > 100) throw new GraphReadError('topology_binding_limit', 503, 'Node binding detail exceeds the supported projection limit');
  const kinds = row.support?.kinds ?? [];
  const classes = new Set<string>(kinds.map(([, , , evidenceClass]) => evidenceClass));
  if (row.kind === 'manual') classes.add('manual');
  const methods = new Set<string>(kinds.flatMap(([kind, method, legacy, evidenceClass]) => relationshipMethods({ kind, method, legacy, evidenceClass })));
  if (row.legacy) methods.add('legacy');
  const supporting = Number(row.support?.count ?? 0);
  const count = supporting > 0 ? String(supporting) : row.legacy || row.kind === 'manual' ? '1' : '0';
  return { id: row.id, kind: row.kind, role: row.role?.trim() || null, label: row.label.trim().slice(0, 255) || `${row.kind} ${row.id}`, bindings: row.bindings,
    lifecycle: row.lifecycle, freshness: freshnessOf(row.support?.freshUntil),
    evidence: { classes: EVIDENCE_CLASSES.filter((value) => classes.has(value)), methods: OBSERVATION_METHODS.filter((value) => methods.has(value)),
      count, lastObservedAt: latest(timestamp(row.lastObservedAt), timestamp(row.support?.observedAt ?? null)) },
    health: health ?? unknownHealth('node'), availableActions: canEdit && row.kind === 'manual' ? ['edit', 'delete'] : [],
    ...(row.inventory ? { inventory: presentInventory(row.inventory) } : {}) };
}
const KNOWN_METHODS: ReadonlySet<string> = new Set(OBSERVATION_METHODS);
/** OS baseline rows carry method `os_network_context`; report what was actually read (interfaces vs routes). */
const OS_CONTEXT_METHODS: Readonly<Record<string, ObservationMethod>> = { network_member: 'os_interface', default_route: 'os_route' };
function relationshipMethods(row: { kind: string; legacy: boolean; method?: string | null; evidenceClass: string }): ObservationMethod[] {
  if (row.legacy) return ['legacy'];
  if (row.method === 'os_network_context') return OS_CONTEXT_METHODS[row.kind] ? [OS_CONTEXT_METHODS[row.kind]!] : [];
  if (row.method && KNOWN_METHODS.has(row.method)) return [row.method as ObservationMethod];
  return row.evidenceClass === 'manual' ? ['manual'] : [];
}
/** `excluded` is only ever true on authorized detail reads; graph reads never return excluded rows. */
export function presentRelationship(row: RelationshipRow, canEdit: boolean, health?: GraphRelationship['health'], excluded = false): GraphRelationship {
  return { id: row.id, kind: row.kind, directionality: row.kind === 'physical_link' ? 'undirected' : 'directed',
    sourceNodeId: row.sourceNodeId, targetNodeId: row.targetNodeId, sourceInterfaceId: row.sourceInterfaceId ?? null, targetInterfaceId: row.targetInterfaceId ?? null,
    meaning: row.kind, directness: row.directness, confidence: row.confidence, lifecycle: row.lifecycle,
    evidence: { classes: [row.evidenceClass], methods: relationshipMethods(row),
      count: row.supportCount, lastObservedAt: timestamp(row.lastSupportedAt) }, freshness: freshnessOf(row.observedFreshUntil), health: health ?? unknownHealth('relationship'),
    excluded, availableActions: canEdit && row.evidenceClass === 'manual' ? ['edit', 'delete'] : [] };
}
export function safeCount(value: string | number | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new GraphReadError('topology_count_limit', 503, 'Topology count exceeds supported precision');
  return count;
}
export const missingSubject = () => new GraphReadError('topology_subject_not_found', 404, 'Topology subject not found');
