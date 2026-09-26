/**
 * Scoped, reversible per-view exclusions of canonical topology relationships
 * (M2 amendments D17; table from Task 7, `topology_view_exclusions`).
 *
 * An exclusion is presentation state only. It hides one relationship from ONE
 * view (edges, counts, frontiers and neighborhood membership of that view).
 * It never changes canonical traversal, incidents, evidence, support,
 * alerts or monitors, and it dispatches nothing. Revocation is history
 * (`revoked_at`), never a delete.
 *
 * Stable exports consumed by the graph read path (Task 9) — keep signatures:
 *
 *   loadActiveExclusions(scope: TopologyScope, view: TopologyView): Promise<Set<string>>
 *     Relationship ids with an ACTIVE exclusion in `view` for this exact
 *     org+site. Runs on the caller's ambient db context (request RLS tx or a
 *     system context); performs no authorization of its own — callers must
 *     already hold an authorized TopologyRequestContext for `scope`.
 *
 *   listViewExclusions(ctx: TopologyRequestContext, query: { view; cursor?; limit? }): Promise<ViewExclusionPage>
 *     Topology read + device read + exact-site authority (the route's
 *     `requireTopologySiteCapability('read')`, re-read live via graphAuthority).
 *     Bounded (limit 1..200, default 50) id-ordered pages; the signed cursor is
 *     bound to view, site graph revision, org/site and authority digest — a
 *     graph revision change returns 409 `graph_revision_changed`.
 *
 *   createViewExclusion(ctx, relationshipId, { view, reason }) / revokeViewExclusion(ctx, relationshipId, exclusionId)
 *     Topology write + exact-site access; atomic under the site write lock,
 *     one graph revision bump and one audit row each. Cross-scope ids → 404.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { topologyScopeSchema, topologyViewSchema, type TopologyScope, type TopologyView } from '@breeze/shared';
import { db } from '../../db';
import { topologyRelationships, topologyViewExclusions } from '../../db/schema';
import { getSecretDerivedKeyMaterials } from '../secretCrypto';
import type { TopologyRequestContext } from './access';
import { loadTopologyFlags } from './flags';
import { GraphReadError, graphAuthority } from './graphCursor';
import { auditTopologyWrite, bumpStructuralRevision, missingTopologyEntity, parseWrite, scopedWrite, TopologyWriteError, withTopologyWrite } from './writes';

const uuid = z.string().uuid();
export const exclusionViewSchema = topologyViewSchema;
export const createViewExclusionSchema = z.object({ view: exclusionViewSchema, reason: z.string().trim().min(1).max(500) }).strict();
export const listViewExclusionsQuerySchema = z.object({
  view: exclusionViewSchema, cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type CreateViewExclusionInput = z.infer<typeof createViewExclusionSchema>;
export type ListViewExclusionsQuery = z.input<typeof listViewExclusionsQuerySchema>;

export type ViewExclusion = {
  id: string; relationshipId: string; view: TopologyView; reason: string; active: boolean;
  createdAt: string; createdBy: string | null; revokedAt: string | null; revokedBy: string | null;
};
export type ViewExclusionWriteResult = ViewExclusion & { graphRevision: string };
export type ViewExclusionRelationshipSummary = {
  id: string; kind: string; sourceNodeId: string; targetNodeId: string;
  sourceInterfaceId: string | null; targetInterfaceId: string | null; evidenceClass: string; lifecycle: string;
};
export type ViewExclusionPage = {
  view: TopologyView; graphRevision: string;
  items: (ViewExclusion & { relationship: ViewExclusionRelationshipSummary })[];
  nextCursor: string | null;
};

type ExclusionRow = typeof topologyViewExclusions.$inferSelect;
function present(row: ExclusionRow): ViewExclusion {
  return {
    id: row.id, relationshipId: row.relationshipId, view: row.view, reason: row.reason, active: row.revokedAt === null,
    createdAt: row.createdAt.toISOString(), createdBy: row.createdBy ?? null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null, revokedBy: row.revokedBy ?? null,
  };
}

/** D9: the physical view is exposed only when deployed (materialization && physical). */
async function physicalViewDeployed(ctx: TopologyRequestContext): Promise<boolean> {
  const flags = await loadTopologyFlags(ctx);
  return flags.materialization && flags.physical;
}

export async function createViewExclusion(ctx: TopologyRequestContext, relationshipId: string, input: CreateViewExclusionInput): Promise<ViewExclusionWriteResult> {
  parseWrite(uuid, relationshipId);
  const value = parseWrite(createViewExclusionSchema, input);
  // Resolve flags BEFORE withTopologyWrite takes the site-state row lock (see writes.ts).
  if (value.view === 'physical' && !await physicalViewDeployed(ctx)) {
    throw new TopologyWriteError('topology_physical_disabled', 409, 'The physical topology view is not enabled');
  }
  return withTopologyWrite(ctx, true, async () => {
    const [relationship] = await db.select({ id: topologyRelationships.id }).from(topologyRelationships)
      .where(and(scopedWrite(ctx.scope, topologyRelationships), eq(topologyRelationships.id, relationshipId), isNull(topologyRelationships.deletedAt)))
      .for('share');
    if (!relationship) throw missingTopologyEntity();
    // The partial unique index (org, site, relationship, view) WHERE revoked_at IS NULL owns active uniqueness.
    const [row] = await db.insert(topologyViewExclusions)
      .values({ ...ctx.scope, relationshipId, view: value.view, reason: value.reason, createdBy: ctx.auth.user.id })
      .onConflictDoNothing().returning();
    if (!row) throw new TopologyWriteError('topology_exclusion_exists', 409, 'This connection is already hidden in this view');
    const graphRevision = await bumpStructuralRevision(ctx.scope);
    await auditTopologyWrite(ctx, 'exclusion.created', row.id, { relationshipId, view: value.view, reason: value.reason });
    return { ...present(row), graphRevision: graphRevision.toString() };
  });
}

export async function revokeViewExclusion(ctx: TopologyRequestContext, relationshipId: string, exclusionId: string): Promise<ViewExclusionWriteResult> {
  parseWrite(uuid, relationshipId); parseWrite(uuid, exclusionId);
  return withTopologyWrite(ctx, true, async () => {
    const selected = and(scopedWrite(ctx.scope, topologyViewExclusions), eq(topologyViewExclusions.id, exclusionId), eq(topologyViewExclusions.relationshipId, relationshipId));
    const [current] = await db.select().from(topologyViewExclusions).where(selected).for('update');
    if (!current) throw missingTopologyEntity();
    if (current.revokedAt) throw new TopologyWriteError('topology_exclusion_not_active', 409, 'This connection is already restored');
    const now = new Date();
    const [row] = await db.update(topologyViewExclusions).set({ revokedAt: now, revokedBy: ctx.auth.user.id, updatedAt: now })
      .where(and(selected, isNull(topologyViewExclusions.revokedAt))).returning();
    if (!row) throw missingTopologyEntity();
    const graphRevision = await bumpStructuralRevision(ctx.scope);
    await auditTopologyWrite(ctx, 'exclusion.revoked', row.id, { relationshipId, view: row.view });
    return { ...present(row), graphRevision: graphRevision.toString() };
  });
}

/** Active exclusions of one view. See the file header for the Task 9 contract. */
export async function loadActiveExclusions(scope: TopologyScope, view: TopologyView): Promise<Set<string>> {
  const rows = await db.select({ relationshipId: topologyViewExclusions.relationshipId }).from(topologyViewExclusions)
    .where(and(eq(topologyViewExclusions.orgId, scope.orgId), eq(topologyViewExclusions.siteId, scope.siteId),
      eq(topologyViewExclusions.view, view), isNull(topologyViewExclusions.revokedAt)));
  return new Set(rows.map((row) => row.relationshipId));
}

const CURSOR_DOMAIN = 'topology-exclusion-cursor:v1';
const cursorClaimsSchema = topologyScopeSchema.extend({
  version: z.literal(1), authority: z.string().regex(/^[a-f0-9]{64}$/), graphRevision: z.string().regex(/^(0|[1-9]\d*)$/),
  view: exclusionViewSchema, after: z.string().uuid(), expiresAt: z.number().int().nonnegative(),
}).strict();
export type ExclusionCursorClaims = z.infer<typeof cursorClaimsSchema>;
const invalidCursor = () => new GraphReadError('invalid_topology_cursor', 400, 'Invalid or expired topology cursor');
export function issueExclusionCursor(claims: Omit<ExclusionCursorClaims, 'version' | 'expiresAt'>, now = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(JSON.stringify(cursorClaimsSchema.parse({ ...claims, version: 1, expiresAt: now + 600 }))).toString('base64url');
  const signature = createHmac('sha256', getSecretDerivedKeyMaterials(CURSOR_DOMAIN).active.key).update(`${CURSOR_DOMAIN}.${body}`).digest('base64url');
  return `${body}.${signature}`;
}
export function verifyExclusionCursor(token: string, authority: string, scope: TopologyScope, now = Math.floor(Date.now() / 1000)): ExclusionCursorClaims {
  if (token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) throw invalidCursor();
  const [body, signature] = token.split('.') as [string, string];
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== 32 || supplied.toString('base64url') !== signature) throw invalidCursor();
  const matches = getSecretDerivedKeyMaterials(CURSOR_DOMAIN).retained.some(({ key }) =>
    timingSafeEqual(supplied, createHmac('sha256', key).update(`${CURSOR_DOMAIN}.${body}`).digest()));
  if (!matches) throw invalidCursor();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw invalidCursor(); }
  const parsed = cursorClaimsSchema.safeParse(value);
  if (!parsed.success || parsed.data.expiresAt <= now) throw invalidCursor();
  if (parsed.data.authority !== authority || parsed.data.orgId !== scope.orgId || parsed.data.siteId !== scope.siteId) throw invalidCursor();
  return parsed.data;
}

export async function listViewExclusions(ctx: TopologyRequestContext, input: ListViewExclusionsQuery): Promise<ViewExclusionPage> {
  const parsed = listViewExclusionsQuerySchema.safeParse(input);
  if (!parsed.success) throw new GraphReadError('invalid_topology_query', 400, 'Invalid topology query');
  const query = parsed.data;
  if (query.view === 'physical' && !await physicalViewDeployed(ctx)) {
    throw new GraphReadError('topology_physical_disabled', 409, 'The physical topology view is not enabled');
  }
  const authority = await graphAuthority(ctx);
  // Publication and lifecycle writers lock this row; SHARE pins the page to one revision.
  const [state] = await db.execute<{ graph: string }>(sql`SELECT graph_revision::text AS graph FROM topology_site_state
    WHERE org_id = ${ctx.scope.orgId}::uuid AND site_id = ${ctx.scope.siteId}::uuid FOR SHARE`);
  const graphRevision = state?.graph ?? '0';
  let after: string | undefined;
  if (query.cursor) {
    const claims = verifyExclusionCursor(query.cursor, authority.digest, ctx.scope);
    if (claims.view !== query.view) throw invalidCursor();
    if (claims.graphRevision !== graphRevision) throw new GraphReadError('graph_revision_changed', 409, 'Topology graph changed; reload the hidden connections');
    after = claims.after;
  }
  const e = topologyViewExclusions; const r = topologyRelationships;
  const rows = await db.select({
    id: e.id, orgId: e.orgId, siteId: e.siteId, relationshipId: e.relationshipId, view: e.view, reason: e.reason, createdBy: e.createdBy,
    revokedAt: e.revokedAt, revokedBy: e.revokedBy, createdAt: e.createdAt, updatedAt: e.updatedAt,
    relationship: { id: r.id, kind: r.kind, sourceNodeId: r.sourceNodeId, targetNodeId: r.targetNodeId, sourceInterfaceId: r.sourceInterfaceId,
      targetInterfaceId: r.targetInterfaceId, evidenceClass: r.evidenceClass, lifecycle: r.lifecycle },
  }).from(e)
    .innerJoin(r, and(eq(r.id, e.relationshipId), eq(r.orgId, e.orgId), eq(r.siteId, e.siteId)))
    .where(and(scopedWrite(ctx.scope, e), eq(e.view, query.view), isNull(e.revokedAt), isNull(r.deletedAt), after ? gt(e.id, after) : undefined))
    .orderBy(asc(e.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    view: query.view, graphRevision,
    items: page.map(({ relationship, ...row }) => ({ ...present(row as ExclusionRow), relationship: relationship as ViewExclusionRelationshipSummary })),
    nextCursor: rows.length > query.limit && last
      ? issueExclusionCursor({ ...ctx.scope, authority: authority.digest, graphRevision, view: query.view, after: last.id }) : null,
  };
}
