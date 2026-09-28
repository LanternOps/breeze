import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { graphQuerySchema, type GraphQuery, type GraphResponse, type Position, type TopologyLinkHealthResponse } from '@breeze/shared';
import { db } from '../../db';
import type { TopologyRequestContext } from './access';
import { GraphReadError, graphAuthority, issueGraphToken, verifyGraphToken, nodeListQuerySchema, topologyReadEtag, type GraphTokenClaims, type NodeListQuery } from './graphCursor';
import { scoped, nodeFilter, listFilter, relationshipFilter, nodeColumns, relationshipColumns, presentNode, presentRelationship, safeCount, missingSubject,
  nodeExposure, relationshipExposure, type NodeRow, type ReadExposure, type RelationshipRow } from './graphRead';
import { loadActiveExclusions } from './exclusions';
import { readGraphCoverage } from './physicalCoverage';
import { projectPhysicalView } from './physicalProjection';
import { readRelationshipDetail, readRelationshipEvidence, type DetailRow } from './relationshipDetail';
import { overlayHealthSummary, type TopologyOverlaySubject } from './monitorOverlays';
import { aggregateTopologySubjectHealth, readTopologySubjectHealth, TOPOLOGY_HEALTH_CONTRIBUTORS, type TopologyHealthContribution } from './subjectHealth';
import { interfaceMeasurementContributions, readTopologyInterfaceMeasurements, topologyInterfaceEvidenceApplies } from './interfaceHealth';

type ReadTx = Pick<typeof db, 'execute'>;
type Authority = Awaited<ReturnType<typeof graphAuthority>>;
type State = { graph: string; health: string };
const uuid = z.string().uuid();
const metadata = new WeakMap<object, string>();
export function getTopologyReadEtag(value: object): string | undefined { return metadata.get(value); }
function response<T extends object>(value: T, authority: Authority, filter: unknown): T {
  const stable = JSON.parse(JSON.stringify(value, (key, entry) => ['asOf', 'token', 'frontierToken', 'cursor'].includes(key) ? undefined : entry));
  metadata.set(value, topologyReadEtag(authority.digest, { filter, response: stable, tokenEpoch: Math.floor(Date.now() / 300_000) }));
  return value;
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid topology query');
  return parsed.data;
}
async function readState(tx: ReadTx, ctx: TopologyRequestContext, claims?: GraphTokenClaims): Promise<State | undefined> {
  // Publication and lifecycle writers lock this same row. SHARE pins every SELECT
  // in this projection even when the request is already in a READ COMMITTED transaction.
  const [state] = await tx.execute<State>(sql`SELECT graph_revision::text AS graph, health_revision::text AS health
    FROM topology_site_state s WHERE ${scoped(ctx.scope, 's')} FOR SHARE`);
  if (claims && claims.graphRevision !== (state?.graph ?? '0')) {
    throw new GraphReadError('graph_revision_changed', 409, 'Topology graph changed; reload the projection');
  }
  return state;
}
function token(ctx: TopologyRequestContext, authority: Authority, revision: string, claims: Pick<GraphTokenClaims, 'kind' | 'filter' | 'after' | 'edgeAfter' | 'boundaryAfter' | 'boundaryOnly' | 'relationshipId'>): string {
  return issueGraphToken({ ...ctx.scope, authority: authority.digest, graphRevision: revision, ...claims });
}
type SubjectHealth = { byKey: Map<string, TopologyHealthContribution[]>; now: Date };
/**
 * Read every health contribution for one projection, keyed by subject
 * (subjectHealth.ts). Reads never dispatch a probe, create a monitor, or
 * advance a revision: health is only ever a view of evidence that exists.
 */
async function overlaysBySubject(
  tx: ReadTx, ctx: TopologyRequestContext, subjects: TopologyOverlaySubject[], authority: Authority, now = new Date(),
): Promise<SubjectHealth> {
  const byKey = await readTopologySubjectHealth({ executor: tx as Pick<typeof db, 'execute'>, ctx, subjects, now, exposure: { interfaceHealth: authority.interfaceHealth } });
  return { byKey, now };
}
function aggregated(overlays: SubjectHealth, scope: 'node' | 'relationship', id: string) {
  return aggregateTopologySubjectHealth(scope, overlays.byKey.get(`${scope}:${id}`) ?? [], overlays.now);
}
function subjectHealth(overlays: SubjectHealth | undefined, scope: 'node' | 'relationship', id: string) {
  return overlays ? aggregated(overlays, scope, id).health : undefined;
}
const earliest = (values: (string | null)[]) => values.filter((value): value is string => !!value).sort()[0] ?? null;
function emptyGraph(ctx: TopologyRequestContext, query: GraphQuery, authority: Authority): GraphResponse {
  return { schemaVersion: 1, siteId: ctx.scope.siteId, view: query.view, asOf: new Date().toISOString(),
    revisions: { graph: '0', health: '0', layout: '0' }, nodes: [], relationships: [], presentation: { nodes: [], edges: [] },
    layout: { algorithm: 'none', version: 0, positions: [] },
    counts: { totalNodes: 0, totalRelationships: 0, visibleNodes: 0, visibleRelationships: 0, omittedNodes: 0, omittedRelationships: 0 },
    coverage: { state: 'unknown', reasons: [{ code: 'topology_preparing', message: 'No topology snapshot has been published.' }] },
    frontier: [], permissions: { canEdit: authority.canEdit, canDiagnose: false, canConfigureMonitoring: false } };
}
async function project(tx: ReadTx, ctx: TopologyRequestContext, query: GraphQuery, authority: Authority, claims?: GraphTokenClaims, groupOnly = false): Promise<GraphResponse> {
  const graph = emptyGraph(ctx, query, authority);
  const state = await readState(tx, ctx, claims);
  if (!state) {
    if (query.focusNodeId) throw missingSubject();
    return response(graph, authority, { query, claims });
  }
  // Per-view exclusions and the physical gate apply to every row, count,
  // neighborhood and frontier of this projection (D9, D17).
  const exposure: ReadExposure = { physical: authority.physical, excluded: await loadActiveExclusions(ctx.scope, query.view, tx) };
  const [layout] = await tx.execute<{ id: string; revision: string; algorithm: string | null; version: string | null }>(sql`
    SELECT l.id, l.revision::text AS revision, l.algorithm, l.algorithm_version AS version FROM topology_layouts l
    WHERE ${scoped(ctx.scope, 'l')} AND l.view = ${query.view} FOR SHARE`);
  if (query.focusNodeId) {
    const found = await tx.execute<{ id: string; kind: string; role: string | null }>(sql`SELECT n.id, n.kind, n.role FROM topology_nodes n WHERE ${scoped(ctx.scope, 'n')}
      AND n.id = ${query.focusNodeId}::uuid AND n.deleted_at IS NULL AND n.alias_target_id IS NULL LIMIT 1`);
    if (!found.length) throw missingSubject();
    if (groupOnly && !['network', 'gateway', 'manual'].includes(found[0]!.kind) && !['switch', 'router', 'access_point', 'firewall'].includes(found[0]!.role ?? '')) {
      throw new GraphReadError('invalid_topology_group', 400, 'Node is not a network or infrastructure group');
    }
  }
  const filter = nodeFilter(ctx.scope, query, 'n', exposure);
  // A fresh focus reserves the first slot. Continuations visit the remaining
  // UUID-ordered members once, including members whose UUID precedes the focus.
  // Keeping the focus on every page would prevent progress when limit is one.
  const after = !claims?.after ? sql`true` : query.focusNodeId
    ? sql`n.id <> ${query.focusNodeId}::uuid AND ${claims.after.toLowerCase() === query.focusNodeId.toLowerCase()
      ? sql`true` : sql`n.id > ${claims.after}::uuid`}`
    : sql`n.id > ${claims.after}::uuid`;
  const nodeOrder = query.focusNodeId
    ? sql`CASE WHEN n.id = ${query.focusNodeId}::uuid THEN 0 ELSE 1 END, n.id`
    : sql`n.id`;
  const [count] = await tx.execute<{ count: string; remaining: string }>(sql`SELECT count(*)::text AS count,
    count(*) FILTER (WHERE ${after})::text AS remaining FROM topology_nodes n WHERE ${filter}`);
  const relationshipScope = sql`${relationshipFilter(ctx.scope, query.view, 'r', exposure)}
    AND EXISTS (SELECT 1 FROM topology_nodes ns WHERE ns.id = r.source_node_id AND ${nodeFilter(ctx.scope, query, 'ns', exposure)})
    AND EXISTS (SELECT 1 FROM topology_nodes nt WHERE nt.id = r.target_node_id AND ${nodeFilter(ctx.scope, query, 'nt', exposure)})`;
  const [relationshipCount] = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM topology_relationships r WHERE ${relationshipScope}`);
  const rows = await tx.execute<NodeRow>(sql`SELECT ${nodeColumns(ctx.scope)} FROM topology_nodes n
    WHERE ${filter} AND ${after} ORDER BY ${nodeOrder} LIMIT ${query.limit}`);
  const ids = rows.map((row) => row.id);
  const idArray = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
  const edgeLimit = Math.min(query.limit * 2, 2000);
  const edgeAfter = claims?.edgeAfter ? sql`r.id > ${claims.edgeAfter}::uuid` : sql`true`;
  const relationships = claims?.boundaryOnly ? [] : await tx.execute<RelationshipRow & { remaining: string }>(sql`SELECT ${relationshipColumns}, count(*) OVER()::text AS remaining FROM topology_relationships r
    WHERE ${relationshipScope} AND r.source_node_id = ANY(${idArray}) AND r.target_node_id = ANY(${idArray}) AND ${edgeAfter}
    ORDER BY r.id LIMIT ${edgeLimit + 1}`);
  const boundaryLimit = edgeLimit - Math.min(relationships.length, edgeLimit);
  const boundaryRows = await tx.execute<{ id: string; sourceNodeId: string; targetNodeId: string; remaining: string }>(sql`
    SELECT r.id, r.source_node_id AS "sourceNodeId", r.target_node_id AS "targetNodeId", count(*) OVER()::text AS remaining FROM topology_relationships r
    WHERE ${relationshipScope} AND ((r.source_node_id = ANY(${idArray})) <> (r.target_node_id = ANY(${idArray})))
      AND ${claims?.boundaryAfter ? sql`r.id > ${claims.boundaryAfter}::uuid` : sql`true`}
    ORDER BY r.id LIMIT ${boundaryLimit + 1}`);
  const boundary = boundaryRows.slice(0, boundaryLimit);
  const positions = layout ? await tx.execute<Position>(sql`SELECT p.node_id AS "nodeId", p.x, p.y, p.pinned, p.position_source AS source, p.revision::text AS "rowRevision"
    FROM topology_node_positions p WHERE ${scoped(ctx.scope, 'p')} AND p.layout_id = ${layout.id}::uuid
      AND p.deleted_at IS NULL AND p.node_id = ANY(${idArray}) ORDER BY p.node_id LIMIT ${query.limit}`) : [];
  const visibleRelationships = relationships.slice(0, edgeLimit);
  const overlays = query.includeHealth
    ? await overlaysBySubject(tx, ctx, [
      ...ids.map((id) => ({ kind: 'node' as const, id })),
      ...visibleRelationships.map((row) => ({ kind: 'relationship' as const, id: row.id })),
    ], authority)
    : undefined;
  graph.nodes = rows.map((row) => presentNode(row, authority.canEdit, subjectHealth(overlays, 'node', row.id)));
  graph.relationships = visibleRelationships.map((row) => presentRelationship(row, authority.canEdit, subjectHealth(overlays, 'relationship', row.id)));
  if (query.view === 'physical') {
    const projected = projectPhysicalView({ nodes: graph.nodes, relationships: graph.relationships, excludedRelationshipIds: exposure.excluded });
    graph.nodes = projected.nodes; graph.relationships = projected.relationships;
  }
  graph.revisions = { graph: state.graph, health: state.health, layout: layout?.revision ?? '0' };
  const version = Number(layout?.version ?? 0);
  graph.layout = { algorithm: layout?.algorithm ?? 'none', version: Number.isSafeInteger(version) && version >= 0 ? version : 0, positions: [...positions] };
  graph.counts = { totalNodes: safeCount(count?.count), totalRelationships: safeCount(relationshipCount?.count),
    visibleNodes: graph.nodes.length, visibleRelationships: graph.relationships.length,
    omittedNodes: safeCount(count?.count) - graph.nodes.length,
    omittedRelationships: safeCount(relationshipCount?.count) - graph.relationships.length };
  graph.coverage = await readGraphCoverage(tx, ctx.scope, query.view, authority.physical);
  if (safeCount(count?.remaining ?? count?.count) > rows.length && rows.length) {
    graph.frontier.push({ token: token(ctx, authority, state.graph, { kind: 'graph', filter: query, after: rows.at(-1)!.id }),
      label: 'More devices', memberCount: safeCount(count?.remaining ?? count?.count) - rows.length });
  }
  if (relationships.length > edgeLimit) {
    graph.frontier.push({ token: token(ctx, authority, state.graph, { kind: 'graph', filter: query, after: claims?.after, edgeAfter: graph.relationships.at(-1)!.id }),
      label: 'More connections in this projection', memberCount: safeCount(relationships[0]?.remaining ?? relationships.length) - edgeLimit });
  }
  if (boundaryRows.length > boundaryLimit) {
    graph.frontier.push({ token: token(ctx, authority, state.graph, { kind: 'graph', filter: query, after: claims?.after,
      boundaryOnly: true, boundaryAfter: boundary.at(-1)?.id ?? claims?.boundaryAfter }),
      label: 'More boundary connections', memberCount: safeCount(boundaryRows[0]?.remaining ?? boundaryRows.length) - boundary.length });
  }
  if (boundary.length) {
    const scopeHash = createHash('sha256').update(`${authority.digest}:${state.graph}:${JSON.stringify(query)}:${claims?.after ?? ''}`).digest('hex').slice(0, 24);
    const groupId = `presentation:${query.view}:${scopeHash}:outside`;
    const firstOutside = ids.includes(boundary[0]!.sourceNodeId) ? boundary[0]!.targetNodeId : boundary[0]!.sourceNodeId;
    const groupToken = token(ctx, authority, state.graph, { kind: 'graph', filter: { ...query, focusNodeId: firstOutside } });
    graph.presentation.nodes.push({ id: groupId, view: query.view, role: 'outside_projection', label: 'Outside this projection',
      authority: false, memberCount: graph.counts.omittedNodes, frontierToken: groupToken });
    graph.presentation.edges = boundary.map((edge) => {
      const sourceVisible = ids.includes(edge.sourceNodeId);
      const outside = sourceVisible ? edge.targetNodeId : edge.sourceNodeId;
      return { id: `presentation:${query.view}:${scopeHash}:edge-${edge.id}`, sourceNodeId: sourceVisible ? edge.sourceNodeId : groupId,
        targetNodeId: sourceVisible ? groupId : edge.targetNodeId, relationshipKind: null, presentationOnly: true, authority: false,
        meaning: 'aggregate', contributingRelationshipIds: [edge.id], memberCount: 1,
        frontierToken: token(ctx, authority, state.graph, { kind: 'graph', filter: { ...query, focusNodeId: outside } }) };
    });
  }
  if (graph.counts.omittedNodes || graph.counts.omittedRelationships) {
    graph.coverage = { state: graph.coverage.state === 'complete' ? 'limited' : graph.coverage.state,
      reasons: [...graph.coverage.reasons, { code: 'projection_bounded', message: 'Some canonical nodes or connections are outside this bounded projection.' }] };
  }
  return response(graph, authority, { query, after: claims?.after, edgeAfter: claims?.edgeAfter, boundaryAfter: claims?.boundaryAfter, boundaryOnly: claims?.boundaryOnly });
}
export async function getTopologyGraph(ctx: TopologyRequestContext, query: GraphQuery): Promise<GraphResponse> {
  const parsed = input(graphQuerySchema, query); const authority = await graphAuthority(ctx);
  return db.transaction((tx) => project(tx, ctx, parsed, authority));
}
export async function expandTopologyGraph(ctx: TopologyRequestContext, encoded: string): Promise<GraphResponse> {
  const authority = await graphAuthority(ctx);
  const claims = verifyGraphToken(encoded, authority.digest, ctx.scope);
  if (claims.kind !== 'graph') throw new GraphReadError('invalid_topology_cursor', 400, 'Cursor is not a graph expansion');
  return db.transaction((tx) => project(tx, ctx, input(graphQuerySchema, claims.filter), authority, claims));
}
export async function listTopologyNodes(ctx: TopologyRequestContext, query: NodeListQuery) {
  const parsed = input(nodeListQuerySchema, query); const authority = await graphAuthority(ctx);
  const { cursor, ...filter } = parsed;
  const claims = cursor ? verifyGraphToken(cursor, authority.digest, ctx.scope) : undefined;
  if (claims && (claims.kind !== 'nodes' || JSON.stringify(claims.filter) !== JSON.stringify(filter))) throw new GraphReadError('invalid_topology_cursor', 400, 'Cursor filters do not match');
  return db.transaction(async (tx) => {
    const state = await readState(tx, ctx, claims);
    const where = listFilter(ctx.scope, filter, { physical: authority.physical });
    const [count] = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM topology_nodes n WHERE ${where}`);
    const rows = await tx.execute<NodeRow>(sql`SELECT ${nodeColumns(ctx.scope)} FROM topology_nodes n WHERE ${where}
      AND ${claims?.after ? sql`n.id > ${claims.after}::uuid` : sql`true`} ORDER BY n.id LIMIT ${parsed.limit + 1}`);
    const visible = rows.slice(0, parsed.limit);
    return response({ siteId: ctx.scope.siteId, graphRevision: state?.graph ?? '0', total: safeCount(count?.count), nodes: visible.map((row) => presentNode(row, authority.canEdit)),
      cursor: rows.length > parsed.limit ? token(ctx, authority, state?.graph ?? '0', { kind: 'nodes', filter, after: visible.at(-1)!.id }) : null }, authority, filter);
  });
}
/** One scoped relationship for detail/evidence. The physical gate hides it (404);
 * a view exclusion never does — authorized detail reports the exclusion instead. */
async function relationship(tx: ReadTx, ctx: TopologyRequestContext, id: string, physical: boolean) {
  const [row] = await tx.execute<DetailRow>(sql`SELECT ${relationshipColumns}, r.attributes->'physical' AS physical FROM topology_relationships r WHERE ${scoped(ctx.scope, 'r')}
    AND r.id = ${id}::uuid AND r.deleted_at IS NULL AND ${relationshipExposure({ physical }, 'r')} LIMIT 1`);
  if (!row) throw missingSubject(); return row;
}
export async function getTopologyNode(ctx: TopologyRequestContext, nodeId: string) {
  input(uuid, nodeId); const authority = await graphAuthority(ctx);
  return db.transaction(async (tx) => {
    const state = await readState(tx, ctx);
    const [row] = await tx.execute<NodeRow>(sql`WITH RECURSIVE aliases AS (
      SELECT a.id, a.alias_target_id, ARRAY[a.id] AS path FROM topology_nodes a
        WHERE ${scoped(ctx.scope, 'a')} AND a.id = ${nodeId}::uuid AND a.deleted_at IS NULL
      UNION ALL SELECT a.id, a.alias_target_id, aliases.path || a.id FROM aliases JOIN topology_nodes a ON a.id = aliases.alias_target_id
        WHERE ${scoped(ctx.scope, 'a')} AND a.deleted_at IS NULL AND NOT a.id = ANY(aliases.path) AND cardinality(aliases.path) < 16
    ) SELECT ${nodeColumns(ctx.scope)} FROM topology_nodes n WHERE ${scoped(ctx.scope, 'n')}
      AND n.id IN (SELECT id FROM aliases WHERE alias_target_id IS NULL) AND n.deleted_at IS NULL AND ${nodeExposure(ctx.scope, authority, 'n')} LIMIT 1`);
    if (!row) throw missingSubject();
    const summaries = await tx.execute<RelationshipRow>(sql`SELECT ${relationshipColumns} FROM topology_relationships r
      WHERE ${relationshipFilter(ctx.scope, 'logical', 'r', { physical: authority.physical, excluded: new Set() })} AND (r.source_node_id = ${row.id}::uuid OR r.target_node_id = ${row.id}::uuid)
      ORDER BY r.id LIMIT 101`);
    const more = summaries.length > 100;
    return response({ siteId: ctx.scope.siteId, graphRevision: state?.graph ?? '0', requestedNodeId: nodeId, node: presentNode(row, authority.canEdit),
      relationships: summaries.slice(0, 100).map((summary) => presentRelationship(summary, authority.canEdit)),
      relationshipFrontier: more ? token(ctx, authority, state?.graph ?? '0', { kind: 'graph', filter: { view: 'logical', focusNodeId: row.id, hops: 1, limit: 500, includeHealth: false } }) : null,
      interfaces: [], capabilities: { diagnostics: false, monitoring: false },
      detailCoverage: { state: 'limited', reason: 'legacy_evidence_only' } }, authority, { nodeId });
  });
}
export async function getTopologyRelationship(ctx: TopologyRequestContext, relationshipId: string) {
  input(uuid, relationshipId); const authority = await graphAuthority(ctx);
  return db.transaction(async (tx) => {
    const state = await readState(tx, ctx); const row = await relationship(tx, ctx, relationshipId, authority.physical);
    const detail = await readRelationshipDetail(tx, ctx.scope, row, { canEdit: authority.canEdit, physical: authority.physical });
    // Detail carries the same aggregated current health as the graph overlay.
    detail.relationship.health = subjectHealth(await overlaysBySubject(tx, ctx, [{ kind: 'relationship', id: row.id }], authority), 'relationship', row.id)!;
    return response({ siteId: ctx.scope.siteId, graphRevision: state?.graph ?? '0', ...detail }, authority, { relationshipId });
  });
}
export const evidenceQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(2048).optional() }).strict();
export async function getTopologyRelationshipEvidence(ctx: TopologyRequestContext, relationshipId: string, query: z.input<typeof evidenceQuerySchema>) {
  input(uuid, relationshipId); const parsed = input(evidenceQuerySchema, query); const authority = await graphAuthority(ctx);
  // Evidence cursors are bound to authority, relationship and graph revision.
  const claims = parsed.cursor ? verifyGraphToken(parsed.cursor, authority.digest, ctx.scope) : undefined;
  if (claims && (claims.kind !== 'evidence' || claims.relationshipId?.toLowerCase() !== relationshipId.toLowerCase() || !claims.after)) {
    throw new GraphReadError('invalid_topology_cursor', 400, 'Cursor does not belong to this relationship');
  }
  return db.transaction(async (tx) => {
    const state = await readState(tx, ctx, claims); const row = await relationship(tx, ctx, relationshipId, authority.physical);
    const page = await readRelationshipEvidence(tx, ctx.scope, row, { limit: parsed.limit, ...(claims?.after ? { after: claims.after } : {}) });
    const { nextAfter, ...body } = page;
    return { siteId: ctx.scope.siteId, graphRevision: state?.graph ?? '0', relationshipId,
      cursor: nextAfter ? token(ctx, authority, state?.graph ?? '0', { kind: 'evidence', relationshipId, after: nextAfter,
        filter: { view: 'overview', hops: 1, includeHealth: false, limit: parsed.limit } }) : null,
      summary: presentRelationship(row, authority.canEdit).evidence, ...body };
  });
}
export async function getTopologyGroupMembers(ctx: TopologyRequestContext, nodeId: string, query: GraphQuery, cursor?: string) {
  input(uuid, nodeId);
  if (cursor) {
    const authority = await graphAuthority(ctx); const claims = verifyGraphToken(cursor, authority.digest, ctx.scope);
    if (claims.kind !== 'graph' || !('view' in claims.filter) || claims.filter.focusNodeId !== nodeId) throw new GraphReadError('invalid_topology_cursor', 400, 'Cursor does not belong to this group');
    return db.transaction((tx) => project(tx, ctx, input(graphQuerySchema, claims.filter), authority, claims, true));
  }
  const authority = await graphAuthority(ctx);
  return db.transaction((tx) => project(tx, ctx, input(graphQuerySchema, { ...query, focusNodeId: nodeId, hops: 1 }), authority, undefined, true));
}
export const healthQuerySchema = z.object({ nodeIds: z.array(uuid).max(1000).default([]), relationshipIds: z.array(uuid).max(2000).default([]), graphRevision: z.string().regex(/^(0|[1-9]\d*)$/).optional() }).strict();
export async function getTopologyHealth(ctx: TopologyRequestContext, query: z.input<typeof healthQuerySchema>) {
  const parsed = input(healthQuerySchema, query); const authority = await graphAuthority(ctx);
  return db.transaction(async (tx) => {
    const state = await readState(tx, ctx);
    if (parsed.graphRevision !== undefined && parsed.graphRevision !== (state?.graph ?? '0')) throw new GraphReadError('graph_revision_changed', 409, 'Topology graph changed; reload the projection');
    type HealthEntry = { id: string; health: ReturnType<typeof overlayHealthSummary> };
    const entities: { nodes: HealthEntry[]; relationships: HealthEntry[] } = { nodes: [], relationships: [] };
    const present: TopologyOverlaySubject[] = [];
    const found: Record<'nodes' | 'relationships', string[]> = { nodes: [], relationships: [] };
    for (const [table, ids, key, kind] of [
      ['topology_nodes', parsed.nodeIds, 'nodes', 'node'], ['topology_relationships', parsed.relationshipIds, 'relationships', 'relationship'],
    ] as const) {
      const unique = [...new Set(ids)]; if (!unique.length) continue;
      const exposed = kind === 'node' ? nodeExposure(ctx.scope, authority, 'e') : relationshipExposure({ physical: authority.physical }, 'e');
      const rows = await tx.execute<{ id: string }>(sql`SELECT e.id FROM ${sql.identifier(table)} e WHERE ${scoped(ctx.scope, 'e')}
        AND e.deleted_at IS NULL AND ${exposed} AND e.id IN (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)}) LIMIT ${unique.length}`);
      if (rows.length !== unique.length) throw missingSubject();
      found[key] = rows.map(({ id }) => id);
      present.push(...rows.map(({ id }) => ({ kind, id })));
    }
    const overlays = present.length ? await overlaysBySubject(tx, ctx, present, authority) : undefined;
    const expiries: (string | null)[] = [];
    const entry = (kind: 'node' | 'relationship', id: string): HealthEntry => {
      if (!overlays) return { id, health: overlayHealthSummary(kind, undefined) };
      const result = aggregated(overlays, kind, id); expiries.push(result.freshUntil);
      return { id, health: result.health };
    };
    entities.nodes = found.nodes.map((id) => entry('node', id));
    entities.relationships = found.relationships.map((id) => entry('relationship', id));
    // M3-D10: freshness expiry is not a revision write. `freshUntil` is the
    // earliest moment this projection changes without new evidence; the
    // content-derived ETag changes with it.
    return response({ siteId: ctx.scope.siteId, graphRevision: state?.graph ?? '0', healthRevision: state?.health ?? '0', freshUntil: earliest(expiries), ...entities }, authority, parsed);
  });
}
/**
 * Current health of one link (M3 Task 6): the aggregated subject health plus
 * each endpoint interface's own measurement. Endpoints are separate views; a
 * rate is never summed across them. Port evidence applies only to identified
 * observed/manual physical links. Read-only and bounded to one relationship.
 */
export async function getTopologyLinkHealth(ctx: TopologyRequestContext, relationshipId: string): Promise<TopologyLinkHealthResponse> {
  input(uuid, relationshipId); const authority = await graphAuthority(ctx);
  return db.transaction(async (tx) => {
    const state = await readState(tx, ctx); const row = await relationship(tx, ctx, relationshipId, authority.physical);
    const now = new Date();
    const subject = { kind: 'relationship' as const, id: row.id };
    const rel = { id: row.id, kind: row.kind, evidenceClass: row.evidenceClass, sourceInterfaceId: row.sourceInterfaceId ?? null, targetInterfaceId: row.targetInterfaceId ?? null };
    const evidence = authority.interfaceHealth ? topologyInterfaceEvidenceApplies(rel) : { applies: false, reason: 'interface_health_unavailable' };
    // Endpoints are read once and shared with the aggregate; every other contributor (monitor, policy) reads as usual.
    const measurements = evidence.applies
      ? await readTopologyInterfaceMeasurements(tx as Pick<typeof db, 'execute'>, ctx.scope, [rel.sourceInterfaceId, rel.targetInterfaceId].filter((id): id is string => !!id), now)
      : new Map();
    const byKey = await readTopologySubjectHealth({ executor: tx as Pick<typeof db, 'execute'>, ctx, subjects: [subject], now, exposure: { interfaceHealth: authority.interfaceHealth } },
      TOPOLOGY_HEALTH_CONTRIBUTORS.filter((contributor) => contributor.source !== 'interface'));
    const contributions = [...(byKey.get(`relationship:${row.id}`) ?? []), ...(evidence.applies ? interfaceMeasurementContributions(rel, measurements) : [])];
    const result = aggregateTopologySubjectHealth('relationship', contributions, now);
    const endpoint = (id: string | null) => (evidence.applies && id ? measurements.get(id) ?? null : null);
    return response({ siteId: ctx.scope.siteId, relationshipId: row.id, graphRevision: state?.graph ?? '0', healthRevision: state?.health ?? '0',
      health: result.health, freshUntil: result.freshUntil, interfaceEvidence: evidence,
      endpoints: { source: endpoint(rel.sourceInterfaceId), target: endpoint(rel.targetInterfaceId) }, asOf: now.toISOString() }, authority, { relationshipId, kind: 'link_health' });
  });
}
