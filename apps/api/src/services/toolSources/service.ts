/**
 * Tool source service — Task A9 (spec 2026-09-07 §5, plan
 * docs/superpowers/plans/ai-mcp/2026-09-07-tool-catalog-w1-tool-sources-mcp.md).
 *
 * Pure functions (auth + db in, DTOs/rows out) backing `routes/toolSources.ts`.
 * Kept route-agnostic so the route file stays a thin permission/validation/
 * wiring layer — every function here takes an already-authenticated
 * `AuthContext`, never a Hono `Context`.
 *
 * Ownership follows CLAUDE.md "Partner-Wide First": `tool_sources` /
 * `tool_source_tools` are org_id XOR partner_id. The dual-axis access
 * condition and owner-resolution helpers below are copied from
 * `routes/softwarePolicies.ts` (`softwarePolicyAccessCondition`,
 * `resolveOrgIdForWrite`) rather than imported — that file is owned by a
 * parallel task and this module must not depend on it.
 *
 * A tool source's `authConfigEncrypted` / `authFingerprint` are NEVER
 * returned by `toToolSourceDto` — every route surfaces `hasCredential`
 * instead.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  organizations,
  toolSources,
  toolSourceTools,
  type ToolSourceRow,
  type ToolSourceToolRow,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { credentialOriginFor, encryptToolSourceAuth, type ToolSourceAuthConfig } from './secrets';
import type { CreateToolSourceInput, PatchToolSourceToolInput, UpdateToolSourceInput } from '@breeze/shared';

export const NAME_NOT_ADDRESSABLE = 'name_not_addressable';

export interface ResolvedOwner {
  orgId: string | null;
  partnerId: string | null;
}

export interface ServiceError {
  status: number;
  error: string;
  code?: string;
}

export interface ToolSourceDto {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  slug: string;
  name: string;
  kind: string;
  endpointUrl: string;
  credentialOrigin: string;
  authKind: string;
  hasCredential: boolean;
  status: string;
  lastDiscoveredAt: Date | null;
  lastError: string | null;
  rateLimitPerMinute: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  toolCount: number;
  enabledToolCount: number;
}

/**
 * Dual-axis access condition (Partner-Wide First): org-owned rows the caller
 * can reach OR partner-wide rows (org_id NULL) owned by the caller's own
 * partner. Mirrors `softwarePolicyAccessCondition` in `routes/softwarePolicies.ts`
 * — copied rather than imported, see module doc.
 */
export function toolSourceAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(toolSources.orgId);
  if (!orgCond) return undefined;
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${toolSources.orgId} IS NULL AND ${toolSources.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

/** Never includes `authConfigEncrypted` / `authFingerprint` — see module doc. */
export function toToolSourceDto(
  row: ToolSourceRow,
  counts?: { toolCount: number; enabledToolCount: number },
): ToolSourceDto {
  return {
    id: row.id,
    orgId: row.orgId,
    partnerId: row.partnerId,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    endpointUrl: row.endpointUrl,
    credentialOrigin: row.credentialOrigin,
    authKind: row.authKind,
    hasCredential: row.authKind !== 'none',
    status: row.status,
    lastDiscoveredAt: row.lastDiscoveredAt,
    lastError: row.lastError,
    rateLimitPerMinute: row.rateLimitPerMinute,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    toolCount: counts?.toolCount ?? 0,
    enabledToolCount: counts?.enabledToolCount ?? 0,
  };
}

export async function getToolCountsForSources(
  sourceIds: string[],
): Promise<Map<string, { toolCount: number; enabledToolCount: number }>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await db
    .select({
      sourceId: toolSourceTools.sourceId,
      toolCount: sql<number>`count(*) filter (where ${toolSourceTools.removedAt} is null)::int`,
      enabledToolCount: sql<number>`count(*) filter (where ${toolSourceTools.enabled} and ${toolSourceTools.removedAt} is null)::int`,
    })
    .from(toolSourceTools)
    .where(inArray(toolSourceTools.sourceId, sourceIds))
    .groupBy(toolSourceTools.sourceId);

  const map = new Map<string, { toolCount: number; enabledToolCount: number }>();
  for (const row of rows) {
    map.set(row.sourceId, { toolCount: row.toolCount, enabledToolCount: row.enabledToolCount });
  }
  return map;
}

export async function listToolSources(
  auth: AuthContext,
  opts: { limit: number; offset: number },
): Promise<{ data: ToolSourceDto[]; pagination: { total: number; limit: number; offset: number } }> {
  const where = toolSourceAccessCondition(auth);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(toolSources)
    .where(where);

  const rows = await db
    .select()
    .from(toolSources)
    .where(where)
    .orderBy(desc(toolSources.updatedAt), desc(toolSources.id))
    .limit(opts.limit)
    .offset(opts.offset);

  const counts = await getToolCountsForSources(rows.map((row) => row.id));

  return {
    data: rows.map((row) => toToolSourceDto(row, counts.get(row.id))),
    pagination: { total: Number(countRow?.count ?? 0), limit: opts.limit, offset: opts.offset },
  };
}

export async function getToolSourceWithAccess(auth: AuthContext, id: string): Promise<ToolSourceRow | null> {
  const conditions: SQL[] = [eq(toolSources.id, id)];
  const accessCondition = toolSourceAccessCondition(auth);
  if (accessCondition) conditions.push(accessCondition);

  const [row] = await db
    .select()
    .from(toolSources)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

/**
 * Owner-axis resolution copied from `resolveOrgIdForWrite` in
 * `routes/softwarePolicies.ts:136-166` (org half) plus the partner-wide gate
 * from that file's POST handler (`:290-333`) — see module doc for why this is
 * a copy, not an import.
 */
export async function resolveToolSourceOwner(
  auth: AuthContext,
  input: { ownerScope?: 'organization' | 'partner'; orgId?: string },
): Promise<{ owner: ResolvedOwner } | ServiceError> {
  if (input.ownerScope === 'partner') {
    if (!auth.partnerId) {
      return { status: 403, error: 'Partner-wide tool sources require partner scope' };
    }
    if (!canManagePartnerWidePolicies(auth)) {
      return { status: 403, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE };
    }
    return { owner: { orgId: null, partnerId: auth.partnerId } };
  }

  const requestedOrgId = input.orgId;
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { status: 400, error: 'Organization context required' };
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { status: 400, error: 'Cannot write outside your organization' };
    }
    return { owner: { orgId: auth.orgId, partnerId: null } };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { status: 403, error: 'Access denied to this organization' };
    }
    return { owner: { orgId: requestedOrgId, partnerId: null } };
  }

  if (auth.orgId) {
    return { owner: { orgId: auth.orgId, partnerId: null } };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { owner: { orgId: auth.accessibleOrgIds[0]!, partnerId: null } };
  }

  return { status: 400, error: 'orgId is required for this scope' };
}

/**
 * True when an org-owned create's slug would shadow an already-visible
 * partner-wide source's slug (same partner, org_id NULL). Defense against a
 * qualified-name collision at resolve time (`resolver.ts` dedupes but logs a
 * warning) — caught here at create time instead as a 409.
 */
export async function slugShadowsPartnerSource(orgId: string, slug: string): Promise<boolean> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = org?.partnerId;
  if (!partnerId) return false;

  const [existing] = await db
    .select({ id: toolSources.id })
    .from(toolSources)
    .where(and(isNull(toolSources.orgId), eq(toolSources.partnerId, partnerId), eq(toolSources.slug, slug)))
    .limit(1);
  return !!existing;
}

/** Flattens the discriminated-union `{authKind, authConfig}` create/update shape into `ToolSourceAuthConfig`. */
function toAuthConfig(input: { authKind?: string; authConfig?: Record<string, unknown> }): ToolSourceAuthConfig {
  const kind = input.authKind ?? 'none';
  const cfg = input.authConfig ?? {};
  switch (kind) {
    case 'bearer':
      return { authKind: 'bearer', token: cfg.token as string };
    case 'api_key_header':
      return { authKind: 'api_key_header', headerName: cfg.headerName as string, value: cfg.value as string };
    case 'basic':
      return { authKind: 'basic', username: cfg.username as string, password: cfg.password as string };
    case 'oauth2_client_credentials':
      return {
        authKind: 'oauth2_client_credentials',
        tokenUrl: cfg.tokenUrl as string,
        clientId: cfg.clientId as string,
        clientSecret: cfg.clientSecret as string,
        scope: cfg.scope as string | undefined,
      };
    default:
      return { authKind: 'none' };
  }
}

export async function createToolSourceRow(
  owner: ResolvedOwner,
  input: CreateToolSourceInput,
  createdByUserId: string,
): Promise<ToolSourceRow> {
  const id = randomUUID();
  const credentialOrigin = credentialOriginFor(input.endpointUrl);
  const { encrypted, fingerprint } = encryptToolSourceAuth(id, toAuthConfig(input));

  const [row] = await db
    .insert(toolSources)
    .values({
      id,
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      endpointUrl: input.endpointUrl,
      credentialOrigin,
      authKind: input.authKind,
      authConfigEncrypted: encrypted,
      authFingerprint: fingerprint,
      rateLimitPerMinute: input.rateLimitPerMinute,
      createdByUserId,
    })
    .returning();
  if (!row) throw new Error('Failed to create tool source');
  return row;
}

export interface UpdateOutcome {
  row: ToolSourceRow;
  discoveryTriggered: boolean;
}

export async function updateToolSourceRow(
  existing: ToolSourceRow,
  input: UpdateToolSourceInput,
): Promise<UpdateOutcome> {
  const updates: Partial<typeof toolSources.$inferInsert> = { updatedAt: new Date() };
  let discoveryTriggered = false;

  if (input.name !== undefined) updates.name = input.name;
  if (input.rateLimitPerMinute !== undefined) updates.rateLimitPerMinute = input.rateLimitPerMinute;

  if (input.endpointUrl !== undefined && input.endpointUrl !== existing.endpointUrl) {
    updates.endpointUrl = input.endpointUrl;
    updates.credentialOrigin = credentialOriginFor(input.endpointUrl);
    discoveryTriggered = true;
  }

  if (input.authKind !== undefined) {
    const cfg = toAuthConfig(input);
    const { encrypted, fingerprint } = encryptToolSourceAuth(existing.id, cfg);
    updates.authKind = input.authKind;
    updates.authConfigEncrypted = encrypted;
    updates.authFingerprint = fingerprint;
    discoveryTriggered = true;
  }

  const [row] = await db
    .update(toolSources)
    .set(updates)
    .where(eq(toolSources.id, existing.id))
    .returning();
  if (!row) throw new Error('Failed to update tool source');
  return { row, discoveryTriggered };
}

/** `tool_source_tools` FK is `ON DELETE CASCADE` — deleting the source deletes its tools at the DB level. */
export async function deleteToolSourceRow(id: string): Promise<void> {
  await db.delete(toolSources).where(eq(toolSources.id, id));
}

export async function listSourceTools(
  sourceId: string,
  opts: { includeRemoved?: boolean },
): Promise<ToolSourceToolRow[]> {
  const conditions: SQL[] = [eq(toolSourceTools.sourceId, sourceId)];
  if (!opts.includeRemoved) conditions.push(isNull(toolSourceTools.removedAt));

  return db
    .select()
    .from(toolSourceTools)
    .where(and(...conditions))
    .orderBy(asc(toolSourceTools.qualifiedName));
}

export async function getSourceTool(sourceId: string, toolId: string): Promise<ToolSourceToolRow | null> {
  const [row] = await db
    .select()
    .from(toolSourceTools)
    .where(and(eq(toolSourceTools.id, toolId), eq(toolSourceTools.sourceId, sourceId)))
    .limit(1);
  return row ?? null;
}

export async function getSourceAndToolWithAccess(
  auth: AuthContext,
  sourceId: string,
  toolId: string,
): Promise<{ source: ToolSourceRow; tool: ToolSourceToolRow } | null> {
  const source = await getToolSourceWithAccess(auth, sourceId);
  if (!source) return null;
  const tool = await getSourceTool(sourceId, toolId);
  if (!tool) return null;
  return { source, tool };
}

export type PatchToolOutcome = { ok: true; row: ToolSourceToolRow; oldTier: number } | (ServiceError & { ok: false });

/**
 * Refuses `enabled: true` on a removed or non-addressable tool (422); sets
 * `tier`/`enabled`; clears `reviewNeeded` whenever a human sets the tier
 * explicitly (that IS the review).
 */
export async function patchSourceTool(
  tool: ToolSourceToolRow,
  patch: PatchToolSourceToolInput,
): Promise<PatchToolOutcome> {
  if (patch.enabled === true && (tool.removedAt !== null || tool.lastError === NAME_NOT_ADDRESSABLE)) {
    return { ok: false, status: 422, error: 'Cannot enable a removed or non-addressable tool' };
  }

  const updates: Partial<typeof toolSourceTools.$inferInsert> = { updatedAt: new Date() };
  if (patch.tier !== undefined) {
    updates.tier = patch.tier;
    updates.reviewNeeded = false;
  }
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;

  const [row] = await db
    .update(toolSourceTools)
    .set(updates)
    .where(eq(toolSourceTools.id, tool.id))
    .returning();
  if (!row) return { ok: false, status: 500, error: 'Failed to update tool' };
  return { ok: true, row, oldTier: tool.tier };
}

/**
 * `enable_reads`: every tier-1, addressable, non-removed tool is enabled.
 * `disable_all`: every tool on the source is disabled, removed or not.
 * Returns the number of rows changed.
 */
export async function bulkToolsAction(sourceId: string, mode: 'enable_reads' | 'disable_all'): Promise<number> {
  if (mode === 'disable_all') {
    const rows = await db
      .update(toolSourceTools)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(toolSourceTools.sourceId, sourceId))
      .returning({ id: toolSourceTools.id });
    return rows.length;
  }

  const rows = await db
    .update(toolSourceTools)
    .set({ enabled: true, updatedAt: new Date() })
    .where(
      and(
        eq(toolSourceTools.sourceId, sourceId),
        eq(toolSourceTools.tier, 1),
        isNull(toolSourceTools.removedAt),
        sql`(${toolSourceTools.lastError} IS DISTINCT FROM ${NAME_NOT_ADDRESSABLE})`,
      ),
    )
    .returning({ id: toolSourceTools.id });
  return rows.length;
}
