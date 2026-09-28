import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  TOPOLOGY_CHANGE_CATEGORIES, TOPOLOGY_CHANGE_KINDS, topologyChangesQuerySchema,
  type TopologyChange, type TopologyChangePage, type TopologyScope,
} from '@breeze/shared';
import { db } from '../../db';
import { getSecretDerivedKeyMaterials } from '../secretCrypto';
import type { TopologyRequestContext } from './access';
import { GraphReadError, graphAuthority } from './graphCursor';
import { nodeExposure, relationshipExposure, scoped } from './graphRead';

/**
 * Recent topology change history (M3 Task 10).
 *
 * There is no structural change log; history is DERIVED from what already
 * exists and is retained: relationship support lifecycle (first positive /
 * withdrawal), manual assertions, collection-source epochs and revocations,
 * incomplete collection runs (gaps), diagnostic run results and configuration
 * outbox entries. Nothing new is persisted and nothing is dispatched.
 *
 *  - Health freshness is not a structural change and never appears here.
 *  - Change history is canonical: per-view exclusions never filter it; the
 *    physical/telemetry capability gates do (hidden producers stay hidden).
 *  - A change whose detailed observation aged out of retention is still
 *    reported from its retained support row, marked `detail: 'expired'`.
 *  - Pages are keyset-ordered (time DESC at microsecond precision, id DESC)
 *    with HMAC cursors bound to scope, authority, graph revision, window and
 *    limit; a changed graph revision is a 409 like every other topology cursor.
 */
type Kind = (typeof TOPOLOGY_CHANGE_KINDS)[number];
type Category = (typeof TOPOLOGY_CHANGE_CATEGORIES)[number];
export type ChangeRow = {
  /** Microsecond-precision UTC timestamp used for the keyset (JS Dates keep only milliseconds). */
  atKey: string;
  at: string | Date;
  id: string;
  kind: Kind;
  category: Category;
  subjectKind: TopologyChange['subject']['kind'];
  subjectId: string;
  evidenceIds: string[];
  detail: TopologyChange['detail'];
  attrs: Record<string, unknown> | null;
};
type Authority = { digest: string; physical: boolean; interfaceHealth: boolean };
type ReadTx = Pick<typeof db, 'execute'>;

const OBSERVATION_RETENTION_MS = 30 * 86_400_000;
const OUTBOX_RETENTION_MS = 7 * 86_400_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRING_ATTRIBUTES = {
  relationshipKind: 24, method: 32, evidenceClass: 16, producerKind: 24, protocol: 32,
  outcome: 24, recipeId: 32, state: 24, assessment: 16, settingsRevision: 32,
} as const;
const UUID_ATTRIBUTES = ['sourceNodeId', 'targetNodeId', 'originNodeId'] as const;

/** Row → wire change. Only typed attributes survive; strings are bounded; nothing raw passes through. */
export function presentTopologyChange(row: ChangeRow): TopologyChange {
  const attrs = row.attrs ?? {};
  const attributes: TopologyChange['attributes'] = {};
  for (const [key, max] of Object.entries(STRING_ATTRIBUTES) as [keyof typeof STRING_ATTRIBUTES, number][]) {
    const value = attrs[key];
    if (typeof value === 'string' && value) attributes[key] = value.slice(0, max);
  }
  for (const key of UUID_ATTRIBUTES) {
    const value = attrs[key];
    if (typeof value === 'string' && uuidPattern.test(value)) attributes[key] = value;
  }
  if (typeof attrs.observedRoutedPath === 'boolean') attributes.observedRoutedPath = attrs.observedRoutedPath;
  return {
    id: row.id.slice(0, 200), at: new Date(row.at).toISOString(), kind: row.kind, category: row.category,
    subject: { kind: row.subjectKind, id: row.subjectId },
    evidenceIds: row.evidenceIds.filter((value) => typeof value === 'string' && value).slice(0, 8).map((value) => value.slice(0, 128)),
    detail: row.detail, attributes,
  };
}

// ---- cursor ----
const DOMAIN = 'topology-changes-cursor:v1';
const cursorSchema = z.object({
  v: z.literal(1), orgId: z.string().uuid(), siteId: z.string().uuid(), authority: z.string().regex(/^[a-f0-9]{64}$/),
  graphRevision: z.string().regex(/^(0|[1-9]\d*)$/), since: z.string(), until: z.string(), limit: z.number().int(),
  atKey: z.string().max(40), id: z.string().max(200), exp: z.number().int(),
}).strict();
type CursorClaims = z.infer<typeof cursorSchema>;
const invalidCursor = () => new GraphReadError('invalid_topology_cursor', 400, 'Invalid or expired topology cursor');
function sign(body: string, key: Buffer) { return createHmac('sha256', key).update(`${DOMAIN}.${body}`).digest(); }
function issueCursor(claims: Omit<CursorClaims, 'v' | 'exp'>): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...claims, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  return `${body}.${sign(body, getSecretDerivedKeyMaterials(DOMAIN).active.key).toString('base64url')}`;
}
function verifyCursor(token: string, expected: Omit<CursorClaims, 'v' | 'exp' | 'atKey' | 'id' | 'graphRevision'>): CursorClaims {
  if (token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) throw invalidCursor();
  const [body, signature] = token.split('.') as [string, string];
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== 32 || supplied.toString('base64url') !== signature) throw invalidCursor();
  if (!getSecretDerivedKeyMaterials(DOMAIN).retained.some(({ key }) => timingSafeEqual(supplied, sign(body, key)))) throw invalidCursor();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw invalidCursor(); }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success || parsed.data.exp <= Math.floor(Date.now() / 1000)) throw invalidCursor();
  const claims = parsed.data;
  for (const key of ['orgId', 'siteId', 'authority', 'since', 'until', 'limit'] as const) {
    if (claims[key] !== expected[key]) throw invalidCursor();
  }
  return claims;
}

// ---- query ----
const atKey = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const within = (column: SQL, since: string, until: string) => sql`${column} >= ${since}::timestamptz AND ${column} < ${until}::timestamptz`;
const category = sql`CASE r.kind WHEN 'attachment' THEN 'attachment' WHEN 'physical_link' THEN 'physical_link' WHEN 'network_member' THEN 'membership' ELSE 'route' END`;
/** Physical-collector producers are hidden with the physical capability; telemetry sources with interface health. */
function sourceExposure(authority: Authority, alias: string): SQL {
  const parts: SQL[] = [];
  if (!authority.physical) parts.push(sql.raw(`${alias}.producer_kind = 'agent'`));
  if (!authority.interfaceHealth) parts.push(sql.raw(`${alias}.protocol <> 'if_metrics'`));
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
}

function branches(scope: TopologyScope, authority: Authority, since: string, until: string): SQL[] {
  const physical = { physical: authority.physical };
  const relAttrs = (withSource: boolean) => sql`jsonb_build_object('relationshipKind', r.kind, 'method', r.attributes->>'method', 'evidenceClass', r.evidence_class,
    'sourceNodeId', r.source_node_id, 'targetNodeId', r.target_node_id${withSource ? sql`, 'producerKind', cs.producer_kind, 'protocol', cs.protocol` : sql``})`;
  const support = (kind: Kind, column: SQL, condition: SQL) => sql`
    SELECT ${column} AS at, ${atKey(column)} AS "atKey", ${`${kind}:`} || rs.relationship_id::text || ':' || rs.source_id::text AS id,
      ${kind}::text AS kind, ${category} AS category, 'relationship' AS "subjectKind", r.id::text AS "subjectId",
      array_remove(ARRAY[r.id::text, rs.source_id::text, o.id::text], NULL) AS "evidenceIds",
      CASE WHEN o.id IS NULL THEN 'expired' ELSE 'available' END AS detail, ${relAttrs(true)} AS attrs
    FROM topology_relationship_support rs
    JOIN topology_relationships r ON r.id = rs.relationship_id AND r.org_id = rs.org_id AND r.site_id = rs.site_id
    JOIN topology_collection_sources cs ON cs.id = rs.source_id AND cs.org_id = rs.org_id AND cs.site_id = rs.site_id
    LEFT JOIN topology_observations o ON o.id = rs.latest_observation_id AND o.org_id = rs.org_id AND o.site_id = rs.site_id
    WHERE ${scoped(scope, 'rs')} AND ${condition} AND ${within(column, since, until)}
      AND ${relationshipExposure(physical, 'r')} AND ${sourceExposure(authority, 'cs')}`;
  const manual = (kind: Kind, column: SQL) => sql`
    SELECT ${column} AS at, ${atKey(column)} AS "atKey", ${`${kind}:`} || r.id::text AS id, ${kind}::text AS kind, ${category} AS category,
      'relationship' AS "subjectKind", r.id::text AS "subjectId", ARRAY[r.id::text] AS "evidenceIds", 'not_applicable' AS detail, ${relAttrs(false)} AS attrs
    FROM topology_relationships r
    WHERE ${scoped(scope, 'r')} AND r.evidence_class = 'manual' AND ${within(column, since, until)} AND ${relationshipExposure(physical, 'r')}`;
  const source = (kind: Kind, column: SQL) => sql`
    SELECT ${column} AS at, ${atKey(column)} AS "atKey", ${`${kind}:`} || cs.id::text || ':' || ${atKey(column)} AS id, ${kind}::text AS kind, 'source' AS category,
      'source' AS "subjectKind", cs.id::text AS "subjectId", ARRAY[cs.id::text] AS "evidenceIds", 'not_applicable' AS detail,
      jsonb_build_object('producerKind', cs.producer_kind, 'protocol', cs.protocol) AS attrs
    FROM topology_collection_sources cs
    WHERE ${scoped(scope, 'cs')} AND ${within(column, since, until)} AND ${sourceExposure(authority, 'cs')}`;
  return [
    support('relationship_observed', sql`rs.first_positive_at`, sql`true`),
    support('relationship_withdrawn', sql`rs.last_miss_at`, sql`rs.lifecycle IN ('withdrawn','archived')`),
    manual('relationship_asserted', sql`r.created_at`),
    manual('relationship_removed', sql`r.deleted_at`),
    source('source_epoch_changed', sql`cs.epoch_issued_at`),
    source('source_revoked', sql`cs.revoked_at`),
    sql`SELECT cr.received_at AS at, ${atKey(sql`cr.received_at`)} AS "atKey", 'collection_gap:' || cr.id::text AS id, 'collection_gap' AS kind,
        'collection' AS category, 'source' AS "subjectKind", cs.id::text AS "subjectId", ARRAY[cr.id::text, cs.id::text] AS "evidenceIds", 'available' AS detail,
        jsonb_build_object('outcome', cr.outcome, 'producerKind', cs.producer_kind, 'protocol', cs.protocol) AS attrs
      FROM topology_collection_runs cr
      JOIN topology_collection_sources cs ON cs.id = cr.source_id AND cs.org_id = cr.org_id AND cs.site_id = cr.site_id
      WHERE ${scoped(scope, 'cr')} AND cr.outcome IN ('partial','failed','unsupported') AND ${within(sql`cr.received_at`, since, until)}
        AND ${sourceExposure(authority, 'cs')}`,
    sql`SELECT dr.finished_at AS at, ${atKey(sql`dr.finished_at`)} AS "atKey", 'measurement_result:' || dr.id::text AS id, 'measurement_result' AS kind,
        'measurement' AS category,
        CASE WHEN dr.subject_node_id IS NOT NULL THEN 'node' WHEN dr.subject_relationship_id IS NOT NULL THEN 'relationship' ELSE 'diagnostic_run' END AS "subjectKind",
        coalesce(dr.subject_node_id, dr.subject_relationship_id, dr.id)::text AS "subjectId", ARRAY[dr.id::text] AS "evidenceIds", 'available' AS detail,
        jsonb_build_object('recipeId', dr.recipe_id, 'state', dr.state, 'assessment', dr.assessment, 'originNodeId', dr.origin_node_id,
          'observedRoutedPath', dr.recipe_id = 'trace_route') AS attrs
      FROM topology_diagnostic_runs dr
      WHERE ${scoped(scope, 'dr')} AND dr.state IN ('completed','failed','cancelled','expired') AND ${within(sql`dr.finished_at`, since, until)}
        AND (dr.subject_relationship_id IS NULL OR EXISTS (SELECT 1 FROM topology_relationships xr WHERE ${scoped(scope, 'xr')}
          AND xr.id = dr.subject_relationship_id AND ${relationshipExposure(physical, 'xr')}))
        AND (dr.subject_node_id IS NULL OR EXISTS (SELECT 1 FROM topology_nodes xn WHERE ${scoped(scope, 'xn')}
          AND xn.id = dr.subject_node_id AND ${nodeExposure(scope, physical, 'xn')}))`,
    sql`SELECT o.created_at AS at, ${atKey(sql`o.created_at`)} AS "atKey", 'configuration_change:' || o.id::text AS id, 'configuration_change' AS kind,
        'configuration' AS category, 'configuration' AS "subjectKind", o.aggregate_id::text AS "subjectId", ARRAY[o.id::text] AS "evidenceIds",
        'available' AS detail, jsonb_build_object('settingsRevision', o.payload->>'settingsRevision') AS attrs
      FROM topology_change_outbox o
      WHERE ${scoped(scope, 'o')} AND o.event_kind = 'configuration.change' AND ${within(sql`o.created_at`, since, until)}`,
  ];
}

/**
 * One bounded page of recent changes (≤ 24 h window, ≤ 200 rows). Every
 * branch is individually keyset-limited, so a busy site never materializes
 * more than `limit + 1` rows per source before the final merge.
 */
export async function getRecentTopologyChanges(
  ctx: TopologyRequestContext,
  query: { since: string; until: string; limit?: number; cursor?: string },
): Promise<TopologyChangePage> {
  const parsed = topologyChangesQuerySchema.safeParse(query);
  if (!parsed.success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid topology change query');
  const { since, until, limit, cursor } = parsed.data;
  const authority = await graphAuthority(ctx);
  const binding = { orgId: ctx.scope.orgId, siteId: ctx.scope.siteId, authority: authority.digest, since, until, limit };
  const claims = cursor ? verifyCursor(cursor, binding) : undefined;
  return db.transaction(async (tx: ReadTx) => {
    const [state] = await tx.execute<{ graph: string }>(sql`SELECT graph_revision::text AS graph FROM topology_site_state s WHERE ${scoped(ctx.scope, 's')} FOR SHARE`);
    const graphRevision = state?.graph ?? '0';
    if (claims && claims.graphRevision !== graphRevision) throw new GraphReadError('graph_revision_changed', 409, 'Topology graph changed; reload the projection');
    const keyset = claims
      ? sql`(b.at < ${claims.atKey}::timestamptz OR (b.at = ${claims.atKey}::timestamptz AND b.id COLLATE "C" < ${claims.id}))`
      : sql`true`;
    const limited = branches(ctx.scope, authority, since, until)
      .map((branch) => sql`(SELECT * FROM (${branch}) b WHERE ${keyset} ORDER BY b.at DESC, b.id COLLATE "C" DESC LIMIT ${limit + 1})`);
    const rows = await tx.execute<ChangeRow>(sql`SELECT * FROM (${sql.join(limited, sql` UNION ALL `)}) c
      ORDER BY c.at DESC, c.id COLLATE "C" DESC LIMIT ${limit + 1}`);
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    const nowMs = Date.now();
    const reasons: string[] = [];
    if (Date.parse(since) < nowMs - OBSERVATION_RETENTION_MS) reasons.push('observation_detail_expired');
    if (Date.parse(since) < nowMs - OUTBOX_RETENTION_MS) reasons.push('change_outbox_detail_expired');
    return {
      siteId: ctx.scope.siteId, graphRevision, window: { since, until },
      changes: visible.map(presentTopologyChange),
      cursor: rows.length > limit && last ? issueCursor({ ...binding, graphRevision, atKey: last.atKey, id: last.id }) : null,
      reasons, asOf: new Date(nowMs).toISOString(),
    };
  });
}
