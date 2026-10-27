/**
 * Manual asset (non-networked inventory, #4622) operations behind
 * routes/devices/manual.ts, shared with the AI tools. Moved verbatim from the
 * route handlers (after their middleware: scope, permission, MFA and body
 * validation) so both callers run the same code. Every function returns
 * `{ status, body }` — exactly what the route sends.
 *
 * Site scoping is injected as `siteAllowed(siteId)` (the route builds it from
 * the caller's `allowedSiteIds` permission); the list additionally takes the
 * raw `allowedSiteIds` allowlist (`null` = unrestricted) because it filters by
 * it rather than only gating on it.
 *
 * Deliberate omissions, matching the design spec:
 *   - `list` excludes retired rows and rows already linked to a device or a
 *     discovered asset — a linked row already surfaces through the arm it
 *     was linked to, so including it would double-count one physical asset.
 *   - Serial number is never uniquely constrained (serials are not globally
 *     unique across manufacturers). `create` runs a soft
 *     `org_id + upper(serial_number)` duplicate check and returns a
 *     non-blocking warning; it never blocks the create.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { manualAssets, sites, devices, discoveredAssets } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import { pgErrorCode, pgErrorConstraint } from '../utils/pgErrors';

export interface ManualAssetOpResult {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
}

export type ManualAssetAudit = (event: RouteAuditInput) => void;
/** True when the caller may touch the given site (unrestricted callers: always true). */
export type SiteAllowed = (siteId: string) => boolean;

type AssetType = (typeof manualAssets.$inferSelect)['assetType'];

export interface ListManualAssetsInput {
  page?: string;
  limit?: string;
  includeTotal?: 'true' | 'false';
  orgId?: string;
  siteId?: string;
  orgIds?: string[];
  siteIds?: string[];
  assetType?: AssetType;
  search?: string;
}

export interface CreateManualAssetInput {
  orgId: string;
  siteId: string;
  name: string;
  assetType?: AssetType;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  assetTag?: string | null;
  location?: string | null;
  assignedContactId?: string | null;
  notes?: string | null;
  tags?: string[];
  purchaseDate?: string | null;
}

export interface UpdateManualAssetInput {
  siteId?: string;
  name?: string;
  assetType?: AssetType;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  assetTag?: string | null;
  location?: string | null;
  assignedContactId?: string | null;
  notes?: string | null;
  tags?: string[];
  purchaseDate?: string | null;
  retiredAt?: string | null;
}

export interface LinkManualAssetInput {
  deviceId?: string;
  discoveredAssetId?: string;
}

const ok = (body: Record<string, unknown>, status: ContentfulStatusCode = 200): ManualAssetOpResult => ({ status, body });
const fail = (error: string, status: ContentfulStatusCode): ManualAssetOpResult => ({ status, body: { error } });

// `manual_assets` carries FIVE FK constraints that can raise 23503 on the
// insert/update statements below (org_id, the composite site FK, the
// composite assigned-contact FK, created_by, updated_by). A blanket
// `pgErrorCode(err) === '23503'` cannot tell which one fired, so it would
// mislabel e.g. a site-deleted-mid-request race as "assigned contact not
// found" — checking the specific constraint NAME keeps the 400 message
// honest and lets every other FK violation fall through to `throw err`
// (500 + logging), which is correct: those are not user-correctable input
// errors at this point in the flow.
export function isAssignedContactFkViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23503'
    && pgErrorConstraint(err) === 'manual_assets_assigned_contact_org_fk';
}

// Loads a manual asset by id and verifies the caller can access its org
// WITHOUT leaking whether a same-id row exists in another org — a wrong-org
// lookup and a missing row both resolve to the identical 404.
export async function loadAccessibleManualAsset(
  auth: Pick<AuthContext, 'canAccessOrg'>,
  id: string,
): Promise<{ error: string; status: 404 } | { row: typeof manualAssets.$inferSelect }> {
  const [existing] = await db.select().from(manualAssets).where(eq(manualAssets.id, id)).limit(1);
  if (!existing) return { error: 'Manual asset not found', status: 404 as const };
  if (!auth.canAccessOrg(existing.orgId)) {
    return { error: 'Manual asset not found', status: 404 as const };
  }
  return { row: existing };
}

export function toDto(r: typeof manualAssets.$inferSelect) {
  return {
    id: r.id,
    deviceClass: 'manual' as const,
    assetType: r.assetType,
    orgId: r.orgId,
    siteId: r.siteId,
    hostname: r.name,
    displayName: r.name,
    // A manual asset has no reachability. 'unknown', never 'offline' —
    // claiming a printer that was never online is "offline" is the kind of
    // small lie that makes an inventory list untrustworthy (spec, Status
    // column).
    status: 'unknown' as const,
    enrolledAt: r.createdAt,
    lastSeenAt: null,
    tags: r.tags ?? [],
    manufacturer: r.manufacturer ?? null,
    model: r.model ?? null,
    notes: r.notes ?? null,
    retiredAt: r.retiredAt ?? null,
    linkedDeviceId: r.linkedDeviceId ?? null,
    linkedDiscoveredAssetId: r.linkedDiscoveredAssetId ?? null,
    // Manual-only fields.
    serialNumber: r.serialNumber ?? null,
    assetTag: r.assetTag ?? null,
    location: r.location ?? null,
    assignedContactId: r.assignedContactId ?? null,
    purchaseDate: r.purchaseDate ?? null,
    purchaseDateSource: r.purchaseDateSource ?? null,
    // Everything an agent or a scanner supplies is null here.
    ipAddress: null, macAddress: null, agentId: null, agentVersion: null,
    watchdogVersion: null, helperVersion: null, osType: null, osVersion: null, osBuild: null,
    architecture: null, cpuPercent: null, ramPercent: null, hardware: null,
    metrics: null, responseTimeMs: null, openPorts: null,
    monitoringEnabled: false, snmpMonitoringEnabled: false, networkMonitoringEnabled: false,
  };
}

// GET /devices/manual — mirrors network.ts's org/site scoping exactly so the
// three arms of the unified list filter consistently.
export async function listManualAssets(params: {
  auth: Pick<AuthContext, 'canAccessOrg' | 'orgCondition'>;
  query: ListManualAssetsInput;
  /** Caller's site allowlist; `null` = unrestricted. */
  allowedSiteIds: string[] | null;
  siteAllowed: SiteAllowed;
}): Promise<ManualAssetOpResult> {
  const { auth, query, allowedSiteIds, siteAllowed } = params;

  const limit = Math.min(1000, Math.max(1, Number.parseInt(query.limit ?? '500', 10) || 500));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];

  const orgFilter = auth.orgCondition(manualAssets.orgId);
  if (orgFilter) conditions.push(orgFilter);

  if (query.orgId) {
    if (!auth.canAccessOrg(query.orgId)) {
      return fail('Access to this organization denied', 403);
    }
    conditions.push(eq(manualAssets.orgId, query.orgId));
  }

  if (query.orgIds && query.orgIds.length > 0) {
    for (const oid of query.orgIds) {
      if (!auth.canAccessOrg(oid)) {
        return fail(`Access to organization ${oid} denied`, 403);
      }
    }
    conditions.push(inArray(manualAssets.orgId, query.orgIds));
  }

  const requestedSiteIds = [
    ...(query.siteId ? [query.siteId] : []),
    ...(query.siteIds ?? []),
  ];
  const uniqueRequestedSiteIds = [...new Set(requestedSiteIds)];

  if (allowedSiteIds) {
    const requestedOutsideAllowlist = uniqueRequestedSiteIds.find(
      (siteId) => !siteAllowed(siteId),
    );
    if (requestedOutsideAllowlist) {
      return fail('Access to this site denied', 403);
    }
    const effectiveSiteIds = uniqueRequestedSiteIds.length > 0
      ? uniqueRequestedSiteIds
      : allowedSiteIds;
    conditions.push(effectiveSiteIds.length > 0
      ? inArray(manualAssets.siteId, effectiveSiteIds)
      : sql`false`);
  } else {
    if (query.siteId) conditions.push(eq(manualAssets.siteId, query.siteId));
    if (query.siteIds && query.siteIds.length > 0) {
      conditions.push(inArray(manualAssets.siteId, query.siteIds));
    }
  }

  // Only unretired, unlinked rows are "active" manual inventory. A linked
  // row surfaces through the device/network arm it links to instead, and a
  // pending discovery observation of the same physical thing must never
  // hide this row — the filter keys ONLY on these link columns, never on a
  // scan's approval state (spec, Codex correction #3).
  conditions.push(isNull(manualAssets.retiredAt));
  conditions.push(isNull(manualAssets.linkedDeviceId));
  conditions.push(isNull(manualAssets.linkedDiscoveredAssetId));

  if (query.assetType) conditions.push(eq(manualAssets.assetType, query.assetType));
  if (query.search) {
    const term = `%${query.search}%`;
    const searchPredicate = or(
      ilike(manualAssets.name, term),
      ilike(manualAssets.serialNumber, term),
      ilike(manualAssets.assetTag, term),
    );
    if (searchPredicate) conditions.push(searchPredicate);
  }

  const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

  let total: number | undefined;
  if (query.includeTotal === 'true') {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(manualAssets)
      .where(whereCondition);
    total = Number(countResult[0]?.count ?? 0);
  }

  const rows = await db
    .select()
    .from(manualAssets)
    .where(whereCondition)
    // `id` tiebreaker for the same reason the network arm needs one
    // (#3462): a bulk import writes many rows with identical timestamps,
    // and an offset page-walk over a tied sort key would silently drop or
    // duplicate a row between pages.
    .orderBy(desc(manualAssets.createdAt), desc(manualAssets.id))
    .limit(limit)
    .offset(offset);

  const data = rows.map(toDto);

  const pagination: { page: number; limit: number; total?: number } = { page, limit };
  if (total !== undefined) pagination.total = total;

  return ok({ data, pagination });
}

// POST /devices/manual — create a manual (non-networked) inventory asset.
export async function createManualAsset(params: {
  auth: Pick<AuthContext, 'canAccessOrg'>;
  actorUserId: string | null;
  data: CreateManualAssetInput;
  siteAllowed: SiteAllowed;
  audit: ManualAssetAudit;
}): Promise<ManualAssetOpResult> {
  const { auth, actorUserId, data, siteAllowed, audit } = params;

  if (!auth.canAccessOrg(data.orgId)) {
    return fail('Access to this organization denied', 403);
  }

  const [targetSite] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, data.siteId), eq(sites.orgId, data.orgId)))
    .limit(1);

  if (!targetSite) {
    return fail('Target site not found or does not belong to the target organization', 400);
  }

  // App-layer site-scope gate (mirrors provision.ts / network.ts) — RLS
  // does not defend the site axis.
  if (!siteAllowed(data.siteId)) {
    return fail('Access to this site denied', 403);
  }

  // Soft duplicate-serial hint. NOT a unique constraint: serials are not
  // globally unique across manufacturers, and a hard constraint would
  // block legitimate re-entry (spec, Data model). Checked BEFORE insert so
  // the warning can ride alongside the created row in one response.
  let duplicateWarning: { code: string; message: string } | undefined;
  if (data.serialNumber) {
    const [dupe] = await db
      .select({ id: manualAssets.id })
      .from(manualAssets)
      .where(and(
        eq(manualAssets.orgId, data.orgId),
        sql`upper(${manualAssets.serialNumber}) = upper(${data.serialNumber})`,
      ))
      .limit(1);
    if (dupe) {
      duplicateWarning = {
        code: 'DUPLICATE_SERIAL',
        message: 'An asset with this serial number already exists in this organization',
      };
    }
  }

  let created: typeof manualAssets.$inferSelect | undefined;
  try {
    [created] = await db.insert(manualAssets).values({
      orgId: data.orgId,
      siteId: data.siteId,
      name: data.name,
      assetType: data.assetType ?? 'unknown',
      manufacturer: data.manufacturer ?? null,
      model: data.model ?? null,
      serialNumber: data.serialNumber ?? null,
      assetTag: data.assetTag ?? null,
      location: data.location ?? null,
      assignedContactId: data.assignedContactId ?? null,
      notes: data.notes ?? null,
      tags: data.tags ?? [],
      purchaseDate: data.purchaseDate ?? null,
      purchaseDateSource: data.purchaseDate ? 'manual' : null,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    }).returning();
  } catch (err: unknown) {
    // The composite (assigned_contact_id, org_id) FK makes a cross-org
    // assignment unrepresentable at the DB layer — surface it as a clean
    // 400 rather than a raw 500. Every OTHER FK on this table falls
    // through to `throw err` (see isAssignedContactFkViolation).
    if (isAssignedContactFkViolation(err)) {
      return fail('Assigned contact not found in this organization', 400);
    }
    throw err;
  }

  if (!created) {
    return fail('Failed to create manual asset', 500);
  }

  audit({
    orgId: created.orgId,
    action: 'manual_asset.create',
    resourceType: 'manual_asset',
    resourceId: created.id,
    resourceName: created.name,
    details: { assetType: created.assetType },
  });

  return ok({
    ...toDto(created),
    ...(duplicateWarning ? { warnings: [duplicateWarning] } : {}),
  }, 201);
}

// PATCH /devices/manual/:id
export async function updateManualAsset(params: {
  auth: Pick<AuthContext, 'canAccessOrg'>;
  actorUserId: string | null;
  id: string;
  data: UpdateManualAssetInput;
  siteAllowed: SiteAllowed;
  audit: ManualAssetAudit;
}): Promise<ManualAssetOpResult> {
  const { auth, actorUserId, id, data, siteAllowed, audit } = params;

  if (Object.keys(data).length === 0) {
    return fail('No updates provided', 400);
  }

  const loaded = await loadAccessibleManualAsset(auth, id);
  if ('error' in loaded) return fail(loaded.error, loaded.status);
  const existing = loaded.row;

  if (!siteAllowed(existing.siteId)) {
    return fail('Access to this site denied', 403);
  }

  // Moving to a different site: verify it's in the same org AND that a
  // site-restricted caller may place the row into the TARGET site (mirrors
  // core.ts's PATCH /:id site-move gate).
  if (data.siteId && data.siteId !== existing.siteId) {
    const [targetSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, data.siteId), eq(sites.orgId, existing.orgId)))
      .limit(1);
    if (!targetSite) {
      return fail('Target site not found or belongs to a different organization', 400);
    }
    if (!siteAllowed(data.siteId)) {
      return fail('Access to this site denied', 403);
    }
  }

  const updates: Partial<typeof manualAssets.$inferInsert> = {
    updatedBy: actorUserId,
    updatedAt: new Date(),
  };
  if (data.siteId !== undefined) updates.siteId = data.siteId;
  if (data.name !== undefined) updates.name = data.name;
  if (data.assetType !== undefined) updates.assetType = data.assetType;
  if (data.manufacturer !== undefined) updates.manufacturer = data.manufacturer ?? null;
  if (data.model !== undefined) updates.model = data.model ?? null;
  if (data.serialNumber !== undefined) updates.serialNumber = data.serialNumber ?? null;
  if (data.assetTag !== undefined) updates.assetTag = data.assetTag ?? null;
  if (data.location !== undefined) updates.location = data.location ?? null;
  if (data.assignedContactId !== undefined) updates.assignedContactId = data.assignedContactId ?? null;
  if (data.notes !== undefined) updates.notes = data.notes ?? null;
  if (data.tags !== undefined) updates.tags = data.tags;
  if (data.retiredAt !== undefined) {
    updates.retiredAt = data.retiredAt === null ? null : new Date(data.retiredAt);
  }
  if (data.purchaseDate !== undefined) {
    // Both NULL or both set — manual_assets_purchase_date_source_chk.
    updates.purchaseDate = data.purchaseDate ?? null;
    updates.purchaseDateSource = data.purchaseDate ? 'manual' : null;
  }

  let updated: typeof manualAssets.$inferSelect | undefined;
  try {
    [updated] = await db.update(manualAssets)
      .set(updates)
      .where(eq(manualAssets.id, id))
      .returning();
  } catch (err: unknown) {
    if (isAssignedContactFkViolation(err)) {
      return fail('Assigned contact not found in this organization', 400);
    }
    throw err;
  }

  // 0-row write despite the prior access-checked SELECT => RLS rejection
  // or a race. Surface it rather than a silent 200.
  if (!updated) {
    return fail('Manual asset not found', 404);
  }

  audit({
    orgId: updated.orgId,
    action: 'manual_asset.update',
    resourceType: 'manual_asset',
    resourceId: updated.id,
    resourceName: updated.name,
    details: { fields: Object.keys(data) },
  });

  return ok(toDto(updated));
}

// DELETE /devices/manual/:id — hard delete.
export async function deleteManualAsset(params: {
  auth: Pick<AuthContext, 'canAccessOrg'>;
  id: string;
  siteAllowed: SiteAllowed;
  audit: ManualAssetAudit;
}): Promise<ManualAssetOpResult> {
  const { auth, id, siteAllowed, audit } = params;

  const loaded = await loadAccessibleManualAsset(auth, id);
  if ('error' in loaded) return fail(loaded.error, loaded.status);
  const existing = loaded.row;

  if (!siteAllowed(existing.siteId)) {
    return fail('Access to this site denied', 403);
  }

  // Check the rowcount: under forced RLS, or a race with a concurrent
  // delete of the same row, a DELETE that matches nothing is a silent
  // no-op, not an error — reporting success (and auditing a delete that
  // never happened) would be a lie (mirrors routes/backup/profiles.ts).
  const deletedRows = await db.delete(manualAssets)
    .where(eq(manualAssets.id, id))
    .returning({ id: manualAssets.id });

  if (deletedRows.length === 0) {
    return fail('Manual asset not found', 404);
  }

  audit({
    orgId: existing.orgId,
    action: 'manual_asset.delete',
    resourceType: 'manual_asset',
    resourceId: existing.id,
    resourceName: existing.name,
  });

  return ok({ success: true });
}

// POST /devices/manual/:id/link — deviceId XOR discoveredAssetId (enforced by
// the route's Zod schema). Same-org AND same-site required, mirroring
// discovery.ts's POST /assets/:id/link. A cross-org target resolves to the
// SAME 404 as a missing target — never leak existence of a record in another
// tenant.
export async function linkManualAsset(params: {
  auth: Pick<AuthContext, 'canAccessOrg'>;
  actorUserId: string | null;
  id: string;
  body: LinkManualAssetInput;
  siteAllowed: SiteAllowed;
  audit: ManualAssetAudit;
}): Promise<ManualAssetOpResult> {
  const { auth, actorUserId, id, body, siteAllowed, audit } = params;

  const loaded = await loadAccessibleManualAsset(auth, id);
  if ('error' in loaded) return fail(loaded.error, loaded.status);
  const existing = loaded.row;

  if (!siteAllowed(existing.siteId)) {
    return fail('Access to this site denied', 403);
  }

  // orgId is checked inline below (never stored) — only siteId needs to
  // survive past the branch to the same-site check.
  let targetSiteId: string;
  let linkUpdate: Partial<typeof manualAssets.$inferInsert>;
  let auditDetails: Record<string, unknown>;

  if (body.deviceId) {
    const [targetDevice] = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, body.deviceId))
      .limit(1);
    // Not-found and wrong-org collapse to the same generic message.
    if (!targetDevice || targetDevice.orgId !== existing.orgId) {
      return fail('Device not found', 404);
    }
    targetSiteId = targetDevice.siteId;
    linkUpdate = { linkedDeviceId: body.deviceId, linkedDiscoveredAssetId: null };
    auditDetails = { linkedDeviceId: body.deviceId };
  } else {
    const [targetAsset] = await db
      .select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId, siteId: discoveredAssets.siteId })
      .from(discoveredAssets)
      .where(eq(discoveredAssets.id, body.discoveredAssetId!))
      .limit(1);
    if (!targetAsset || targetAsset.orgId !== existing.orgId) {
      return fail('Discovered asset not found', 404);
    }
    targetSiteId = targetAsset.siteId;
    linkUpdate = { linkedDiscoveredAssetId: body.discoveredAssetId, linkedDeviceId: null };
    auditDetails = { linkedDiscoveredAssetId: body.discoveredAssetId };
  }

  if (targetSiteId !== existing.siteId) {
    return fail(
      body.deviceId
        ? 'Device does not belong to the same site as this asset'
        : 'Discovered asset does not belong to the same site as this asset',
      400,
    );
  }

  const [updated] = await db.update(manualAssets)
    .set({ ...linkUpdate, updatedBy: actorUserId, updatedAt: new Date() })
    .where(eq(manualAssets.id, id))
    .returning();

  // 0-row write despite the prior access-checked load => RLS rejection or a
  // race with a concurrent delete/re-org of this row. Same classification
  // as update and unlink — a lost race is "not found", not a server fault.
  if (!updated) {
    return fail('Manual asset not found', 404);
  }

  audit({
    orgId: updated.orgId,
    action: 'manual_asset.link',
    resourceType: 'manual_asset',
    resourceId: updated.id,
    resourceName: updated.name,
    details: auditDetails,
  });

  return ok(toDto(updated));
}

// DELETE /devices/manual/:id/link — clears both link columns unconditionally.
export async function unlinkManualAsset(params: {
  auth: Pick<AuthContext, 'canAccessOrg'>;
  actorUserId: string | null;
  id: string;
  siteAllowed: SiteAllowed;
  audit: ManualAssetAudit;
}): Promise<ManualAssetOpResult> {
  const { auth, actorUserId, id, siteAllowed, audit } = params;

  const loaded = await loadAccessibleManualAsset(auth, id);
  if ('error' in loaded) return fail(loaded.error, loaded.status);
  const existing = loaded.row;

  if (!siteAllowed(existing.siteId)) {
    return fail('Access to this site denied', 403);
  }

  const [updated] = await db.update(manualAssets)
    .set({
      linkedDeviceId: null,
      linkedDiscoveredAssetId: null,
      updatedBy: actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(manualAssets.id, id))
    .returning();

  if (!updated) {
    return fail('Manual asset not found', 404);
  }

  audit({
    orgId: updated.orgId,
    action: 'manual_asset.unlink',
    resourceType: 'manual_asset',
    resourceId: updated.id,
    resourceName: updated.name,
    details: {
      previousLinkedDeviceId: existing.linkedDeviceId,
      previousLinkedDiscoveredAssetId: existing.linkedDiscoveredAssetId,
    },
  });

  return ok(toDto(updated));
}
