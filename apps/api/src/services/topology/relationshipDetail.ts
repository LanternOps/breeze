import { sql } from 'drizzle-orm';
import {
  OBSERVATION_METHODS, type GraphRelationship, type ObservationMethod, type RelationshipDetailResponse,
  type RelationshipEvidenceResponse, type TopologyScope,
} from '@breeze/shared';
import type { db } from '../../db';
import { nodeLabelSql, presentRelationship, relationshipExposure, scoped, type RelationshipRow } from './graphRead';

/**
 * Relationship detail and evidence reads (M2 D11, D17). Authorized detail is
 * never hidden by a view exclusion: it reports the exclusion instead. Graph
 * edges keep interface IDs only; port names live here. Read-only.
 */
type ReadTx = Pick<typeof db, 'execute'>;
type PortRef = { namespace?: unknown; value?: unknown };
type TypedId = { subtype?: unknown; value?: unknown };
/** The subset of `attributes.physical` (physicalProjector) this read uses. */
export type PhysicalAttributes = {
  resolution?: unknown; localPort?: PortRef; remoteChassis?: TypedId; remotePort?: TypedId; fdbSelection?: unknown;
  alternativeRelationshipIds?: unknown; association?: unknown;
};
export type DetailRow = RelationshipRow & { physical?: PhysicalAttributes | null };
type Detail = Omit<RelationshipDetailResponse, 'siteId' | 'graphRevision'>;
type Port = NonNullable<Detail['endpoints']['source']['port']>;

const PHYSICAL_KINDS = new Set(['physical_link', 'attachment']);
const FDB_SELECTIONS = new Set(['selected', 'competing', 'excluded', 'none']);
const ASSOCIATIONS = new Set(['wired', 'wireless', 'vpn']);
const METHODS: ReadonlySet<string> = new Set(OBSERVATION_METHODS);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const bounded = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 255) : '';
const timestamp = (value: string | Date) => new Date(value).toISOString();

function reported(ref: PortRef | TypedId | undefined, namespaceKey: 'namespace' | 'subtype'): Detail['endpoints']['source']['reportedPort'] {
  const namespace = bounded((ref as Record<string, unknown> | undefined)?.[namespaceKey]).slice(0, 64);
  const value = bounded(ref?.value);
  return namespace && value ? { namespace, value } : null;
}

/** Method, resolution and truthful port role of a physical (or manual/legacy physical) relationship. */
export function physicalDetail(row: DetailRow): Detail['physical'] {
  if (!PHYSICAL_KINDS.has(row.kind)) return null;
  const physical = row.physical ?? {};
  const method = row.legacy ? 'legacy' : row.method && METHODS.has(row.method) ? row.method as ObservationMethod : row.evidenceClass === 'manual' ? 'manual' : null;
  const selection = typeof physical.fdbSelection === 'string' && FDB_SELECTIONS.has(physical.fdbSelection) ? physical.fdbSelection as NonNullable<Detail['physical']>['fdbSelection'] : null;
  const resolution = physical.resolution === 'resolved' || physical.resolution === 'unresolved' ? physical.resolution : null;
  const association = typeof physical.association === 'string' && ASSOCIATIONS.has(physical.association) ? physical.association as 'wired' | 'wireless' | 'vpn'
    : method === 'lldp' || method === 'cdp' ? 'wired' : null;
  // Port role never promotes an inference: FDB learns a MAC THROUGH a port; a
  // shared/upstream (infrastructure) port is excluded from parent selection.
  const portRole = method === 'fdb' && selection === 'excluded' ? 'shared'
    : !row.sourceInterfaceId ? 'unresolved'
      : method === 'fdb' ? 'learned' : 'identified';
  return { method, resolution, portRole, association, fdbSelection: method === 'fdb' ? selection ?? 'none' : null };
}

export function detailCoverage(row: DetailRow, relationship: GraphRelationship, physical: Detail['physical']): Detail['detailCoverage'] {
  if (row.legacy) return { state: 'limited', reason: 'legacy_evidence_only' };
  if (row.evidenceClass === 'manual') return { state: 'limited', reason: 'manual_assertion' };
  if (physical?.portRole === 'unresolved') return { state: 'limited', reason: 'interface_unresolved' };
  if (physical?.fdbSelection === 'competing') return { state: 'limited', reason: 'fdb_competing_candidates' };
  if (physical?.portRole === 'shared') return { state: 'limited', reason: 'shared_port' };
  if (relationship.freshness === 'stale') return { state: 'limited', reason: 'evidence_stale' };
  if (relationship.freshness === 'unknown') return { state: 'unknown', reason: 'evidence_freshness_unknown' };
  return { state: 'complete', reason: null };
}

export async function readRelationshipDetail(tx: ReadTx, scope: TopologyScope, row: DetailRow, options: { canEdit: boolean; physical: boolean }): Promise<Detail> {
  const exclusions = await tx.execute<{ id: string; view: 'overview' | 'physical' | 'logical'; reason: string; createdAt: string | Date }>(sql`
    SELECT e.id, e.view, e.reason, e.created_at AS "createdAt" FROM topology_view_exclusions e
    WHERE ${scoped(scope, 'e')} AND e.relationship_id = ${row.id}::uuid AND e.revoked_at IS NULL ORDER BY e.view LIMIT 3`);
  const relationship = presentRelationship(row, options.canEdit, undefined, exclusions.length > 0);
  const physical = physicalDetail(row);
  const alternativeIds = Array.isArray(row.physical?.alternativeRelationshipIds)
    ? (row.physical!.alternativeRelationshipIds as unknown[]).filter((id): id is string => typeof id === 'string' && uuidPattern.test(id)).slice(0, 50) : [];
  const alternatives = alternativeIds.length ? await tx.execute<{ id: string; sourceNodeId: string; targetNodeId: string; sourceInterfaceId: string | null; confidence: GraphRelationship['confidence'] }>(sql`
    SELECT r.id, r.source_node_id AS "sourceNodeId", r.target_node_id AS "targetNodeId", r.source_interface_id AS "sourceInterfaceId", r.confidence
    FROM topology_relationships r WHERE ${scoped(scope, 'r')} AND r.deleted_at IS NULL AND r.lifecycle = 'active'
      AND r.id = ANY(${idArray(alternativeIds)}) AND ${relationshipExposure({ physical: options.physical }, 'r')} ORDER BY r.id LIMIT 50`) : [];
  const interfaceIds = [...new Set([row.sourceInterfaceId, row.targetInterfaceId, ...alternatives.map((a) => a.sourceInterfaceId)].filter((id): id is string => !!id))];
  const interfaces = interfaceIds.length ? await tx.execute<{ id: string; name: string | null; alias: string | null; key: string; retired: boolean }>(sql`
    SELECT i.id, i.name, i.alias, i.interface_key AS key, (i.retired_at IS NOT NULL) AS retired FROM topology_interfaces i
    WHERE ${scoped(scope, 'i')} AND i.id = ANY(${idArray(interfaceIds)}) LIMIT ${interfaceIds.length}`) : [];
  const nodeIds = [...new Set([row.sourceNodeId, row.targetNodeId, ...alternatives.map((a) => a.sourceNodeId)])];
  const labels = await tx.execute<{ id: string; label: string }>(sql`SELECT n.id, ${nodeLabelSql} AS label FROM topology_nodes n
    WHERE ${scoped(scope, 'n')} AND n.id = ANY(${idArray(nodeIds)}) LIMIT ${nodeIds.length}`);
  const ports = new Map(interfaces.map((i): [string, Port] => [i.id, { interfaceId: i.id, name: i.name?.slice(0, 255) ?? null, alias: i.alias?.slice(0, 255) ?? null, key: i.key.slice(0, 255), retired: !!i.retired }]));
  const label = (id: string) => labels.find((n) => n.id === id)?.label.trim().slice(0, 255) || id;
  const port = (id: string | null | undefined) => (id ? ports.get(id) : undefined) ?? null;
  const sourcePort = port(row.sourceInterfaceId), targetPort = port(row.targetInterfaceId);
  return {
    relationship,
    endpoints: {
      source: { nodeId: row.sourceNodeId, label: label(row.sourceNodeId), port: sourcePort, reportedPort: sourcePort ? null : reported(row.physical?.localPort, 'namespace') },
      target: { nodeId: row.targetNodeId, label: label(row.targetNodeId), port: targetPort, reportedPort: targetPort ? null : reported(row.physical?.remotePort, 'subtype') },
    },
    physical,
    alternatives: alternatives.map((a) => ({ relationshipId: a.id, sourceNodeId: a.sourceNodeId, sourceNodeLabel: label(a.sourceNodeId), targetNodeId: a.targetNodeId, port: port(a.sourceInterfaceId), confidence: a.confidence })),
    exclusions: exclusions.map((e) => ({ id: e.id, view: e.view, reason: e.reason, createdAt: timestamp(e.createdAt) })),
    detailCoverage: detailCoverage(row, relationship, physical),
  };
}

type EvidencePage = Omit<RelationshipEvidenceResponse, 'siteId' | 'graphRevision' | 'relationshipId' | 'cursor' | 'summary'> & { nextAfter: string | null };
type ObservationRow = { id: string; method: string; evidenceClass: 'observed' | 'inferred' | 'manual'; producerKind: 'agent' | 'snmp' | 'unifi' | 'discovery'; protocol: string;
  observedAt: string | Date; effectiveAt: string | Date; receivedAt: string | Date; freshUntil: string | Date; withdrawnAt: string | Date | null };

/** One page of scoped observations (newest first), plus confirmations on the first page. */
export async function readRelationshipEvidence(tx: ReadTx, scope: TopologyScope, row: DetailRow, page: { limit: number; after?: string }, now = new Date()): Promise<EvidencePage> {
  const after = page.after ? sql`(o.received_at, o.id) < (SELECT a.received_at, a.id FROM topology_observations a WHERE ${scoped(scope, 'a')} AND a.id = ${page.after}::uuid)` : sql`true`;
  const rows = await tx.execute<ObservationRow>(sql`
    SELECT o.id, o.method, o.evidence_class AS "evidenceClass", cs.producer_kind AS "producerKind", cs.protocol,
      o.observed_at AS "observedAt", o.effective_at AS "effectiveAt", o.received_at AS "receivedAt", o.fresh_until AS "freshUntil", o.withdrawn_at AS "withdrawnAt"
    FROM topology_observations o
    JOIN topology_collection_runs cr ON cr.id = o.run_id AND cr.org_id = o.org_id AND cr.site_id = o.site_id
    JOIN topology_collection_sources cs ON cs.id = cr.source_id AND cs.org_id = cr.org_id AND cs.site_id = cr.site_id
    WHERE ${scoped(scope, 'o')} AND o.relationship_id = ${row.id}::uuid AND ${after}
    ORDER BY o.received_at DESC, o.id DESC LIMIT ${page.limit + 1}`);
  const visible = rows.slice(0, page.limit);
  const confirmations = page.after ? [] : await tx.execute<{ sourceId: string; producerKind: ObservationRow['producerKind']; protocol: string; firstPositiveAt: string | Date;
    lastPositiveAt: string | Date; freshUntil: string | Date; lifecycle: 'active' | 'withdrawn' | 'archived'; completeMissCount: number }>(sql`
    SELECT rs.source_id AS "sourceId", cs.producer_kind AS "producerKind", cs.protocol, rs.first_positive_at AS "firstPositiveAt",
      rs.last_positive_at AS "lastPositiveAt", rs.fresh_until AS "freshUntil", rs.lifecycle, rs.complete_miss_count AS "completeMissCount"
    FROM topology_relationship_support rs JOIN topology_collection_sources cs ON cs.id = rs.source_id AND cs.org_id = rs.org_id AND cs.site_id = rs.site_id
    WHERE ${scoped(scope, 'rs')} AND rs.relationship_id = ${row.id}::uuid ORDER BY rs.last_positive_at DESC, rs.source_id LIMIT 200`);
  const observations = visible.filter((o) => METHODS.has(o.method)).map((o) => ({
    id: o.id, method: o.method as ObservationMethod, evidenceClass: o.evidenceClass, producerKind: o.producerKind, protocol: o.protocol.slice(0, 32),
    observedAt: timestamp(o.observedAt), effectiveAt: timestamp(o.effectiveAt), receivedAt: timestamp(o.receivedAt), freshUntil: timestamp(o.freshUntil),
    status: o.withdrawnAt ? 'withdrawn' as const : new Date(o.freshUntil).getTime() <= now.getTime() ? 'expired' as const : 'current' as const,
  }));
  const details: EvidencePage['details'] = row.legacy ? { state: 'unavailable', reason: 'legacy_summary_only' }
    : visible.length || page.after ? { state: 'available', reason: null }
      // Support survives observation retention: the relationship was confirmed but its detail aged out.
      : confirmations.length ? { state: 'expired', reason: 'observation_detail_expired' }
        : { state: 'unavailable', reason: 'observation_collection_unavailable' };
  return {
    observations, details, nextAfter: rows.length > page.limit ? visible.at(-1)!.id : null,
    confirmations: confirmations.map((c) => ({ sourceId: c.sourceId, producerKind: c.producerKind, protocol: c.protocol.slice(0, 32), firstPositiveAt: timestamp(c.firstPositiveAt),
      lastPositiveAt: timestamp(c.lastPositiveAt), freshUntil: timestamp(c.freshUntil), lifecycle: c.lifecycle, completeMissCount: Number(c.completeMissCount) })),
  };
}
