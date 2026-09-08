import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { manualAssets, sites, devices, discoveredAssets } from '../../db/schema';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import {
  listManualAssetsSchema,
  createManualAssetSchema,
  updateManualAssetSchema,
  linkManualAssetSchema,
} from './schemas';

export const manualRoutes = new Hono();

manualRoutes.use('*', authMiddleware);

/**
 * The manual arm of the unified Devices list (#4622 W02).
 *
 * Surfaces hand-entered, non-networked inventory rows (`manual_assets`) —
 * a spare laptop, a desk phone, a non-networked printer — normalized into
 * the same presentation shape the agent-device and network arms use,
 * tagged `deviceClass: 'manual'`.
 *
 * Deliberate omissions, matching the design spec:
 *   - No MFA step-up middleware anywhere in this file. Manual asset writes
 *     are ordinary inventory edits with no blast radius beyond the org's own
 *     records — matching device edit, not the discovery mutators.
 *   - `GET` excludes retired rows and rows already linked to a device or a
 *     discovered asset — a linked row already surfaces through the arm it
 *     was linked to, so including it here would double-count one physical
 *     asset.
 *   - Serial number is never uniquely constrained (spec: serials are not
 *     globally unique across manufacturers). `POST` runs a soft
 *     `org_id + upper(serial_number)` duplicate check and returns a
 *     non-blocking warning; it never blocks the create.
 */

// A helper duplicated by design (small, three call sites): loads a manual
// asset by id and verifies the caller can access its org WITHOUT leaking
// whether a same-id row exists in another org — a wrong-org lookup and a
// missing row both resolve to the identical 404.
// `manual_assets` carries FIVE FK constraints that can raise 23503 on the
// insert/update statements below (org_id, the composite site FK, the
// composite assigned-contact FK, created_by, updated_by). A blanket
// `pgErrorCode(err) === '23503'` cannot tell which one fired, so it would
// mislabel e.g. a site-deleted-mid-request race as "assigned contact not
// found" — checking the specific constraint NAME keeps the 400 message
// honest and lets every other FK violation fall through to `throw err`
// (500 + logging), which is correct: those are not user-correctable input
// errors at this point in the flow.
function isAssignedContactFkViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23503'
    && pgErrorConstraint(err) === 'manual_assets_assigned_contact_org_fk';
}

async function loadAccessibleManualAsset(
  auth: { canAccessOrg: (orgId: string) => boolean },
  id: string,
) {
  const [existing] = await db.select().from(manualAssets).where(eq(manualAssets.id, id)).limit(1);
  if (!existing) return { error: 'Manual asset not found', status: 404 as const };
  if (!auth.canAccessOrg(existing.orgId)) {
    return { error: 'Manual asset not found', status: 404 as const };
  }
  return { row: existing };
}

function toDto(r: typeof manualAssets.$inferSelect) {
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
    // Everything an agent or a scanner supplies is null here.
    ipAddress: null, macAddress: null, agentId: null, agentVersion: null,
    watchdogVersion: null, osType: null, osVersion: null, osBuild: null,
    architecture: null, cpuPercent: null, ramPercent: null, hardware: null,
    metrics: null, responseTimeMs: null, openPorts: null,
    monitoringEnabled: false, snmpMonitoringEnabled: false, networkMonitoringEnabled: false,
  };
}

// GET /devices/manual — mirrors network.ts's org/site scoping exactly so the
// three arms of the unified list filter consistently.
manualRoutes.get(
  '/manual',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listManualAssetsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const limit = Math.min(1000, Math.max(1, Number.parseInt(query.limit ?? '500', 10) || 500));
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const offset = (page - 1) * limit;

    const conditions: SQL[] = [];

    const orgFilter = auth.orgCondition(manualAssets.orgId);
    if (orgFilter) conditions.push(orgFilter);

    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(manualAssets.orgId, query.orgId));
    }

    if (query.orgIds && query.orgIds.length > 0) {
      for (const oid of query.orgIds) {
        if (!auth.canAccessOrg(oid)) {
          return c.json({ error: `Access to organization ${oid} denied` }, 403);
        }
      }
      conditions.push(inArray(manualAssets.orgId, query.orgIds));
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const allowedSiteIds = permissions?.allowedSiteIds;
    const requestedSiteIds = [
      ...(query.siteId ? [query.siteId] : []),
      ...(query.siteIds ?? []),
    ];
    const uniqueRequestedSiteIds = [...new Set(requestedSiteIds)];

    if (allowedSiteIds) {
      const requestedOutsideAllowlist = uniqueRequestedSiteIds.find(
        (siteId) => !canAccessSite(permissions!, siteId),
      );
      if (requestedOutsideAllowlist) {
        return c.json({ error: 'Access to this site denied' }, 403);
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

    return c.json({ data, pagination });
  },
);

// POST /devices/manual — create a manual (non-networked) inventory asset.
manualRoutes.post(
  '/manual',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', createManualAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    if (!auth.canAccessOrg(data.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const [targetSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, data.siteId), eq(sites.orgId, data.orgId)))
      .limit(1);

    if (!targetSite) {
      return c.json(
        { error: 'Target site not found or does not belong to the target organization' },
        400,
      );
    }

    // App-layer site-scope gate (mirrors provision.ts / network.ts) — RLS
    // does not defend the site axis.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, data.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
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
        createdBy: auth.user.id,
        updatedBy: auth.user.id,
      }).returning();
    } catch (err: unknown) {
      // The composite (assigned_contact_id, org_id) FK makes a cross-org
      // assignment unrepresentable at the DB layer — surface it as a clean
      // 400 rather than a raw 500. Every OTHER FK on this table falls
      // through to `throw err` (see isAssignedContactFkViolation).
      if (isAssignedContactFkViolation(err)) {
        return c.json({ error: 'Assigned contact not found in this organization' }, 400);
      }
      throw err;
    }

    if (!created) {
      return c.json({ error: 'Failed to create manual asset' }, 500);
    }

    writeRouteAudit(c, {
      orgId: created.orgId,
      action: 'manual_asset.create',
      resourceType: 'manual_asset',
      resourceId: created.id,
      resourceName: created.name,
      details: { assetType: created.assetType },
    });

    return c.json({
      ...toDto(created),
      ...(duplicateWarning ? { warnings: [duplicateWarning] } : {}),
    }, 201);
  },
);

// PATCH /devices/manual/:id
manualRoutes.patch(
  '/manual/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', updateManualAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const loaded = await loadAccessibleManualAsset(auth, id);
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const existing = loaded.row;

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
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
        return c.json({ error: 'Target site not found or belongs to a different organization' }, 400);
      }
      if (perms?.allowedSiteIds && !canAccessSite(perms, data.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
    }

    const updates: Partial<typeof manualAssets.$inferInsert> = {
      updatedBy: auth.user.id,
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

    let updated: typeof manualAssets.$inferSelect | undefined;
    try {
      [updated] = await db.update(manualAssets)
        .set(updates)
        .where(eq(manualAssets.id, id))
        .returning();
    } catch (err: unknown) {
      if (isAssignedContactFkViolation(err)) {
        return c.json({ error: 'Assigned contact not found in this organization' }, 400);
      }
      throw err;
    }

    // 0-row write despite the prior access-checked SELECT => RLS rejection
    // or a race. Surface it rather than a silent 200.
    if (!updated) {
      return c.json({ error: 'Manual asset not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'manual_asset.update',
      resourceType: 'manual_asset',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { fields: Object.keys(data) },
    });

    return c.json(toDto(updated));
  },
);

// DELETE /devices/manual/:id — hard delete.
manualRoutes.delete(
  '/manual/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;

    const loaded = await loadAccessibleManualAsset(auth, id);
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const existing = loaded.row;

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Check the rowcount: under forced RLS, or a race with a concurrent
    // delete of the same row, a DELETE that matches nothing is a silent
    // no-op, not an error — reporting success (and auditing a delete that
    // never happened) would be a lie (mirrors routes/backup/profiles.ts).
    const deletedRows = await db.delete(manualAssets)
      .where(eq(manualAssets.id, id))
      .returning({ id: manualAssets.id });

    if (deletedRows.length === 0) {
      return c.json({ error: 'Manual asset not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'manual_asset.delete',
      resourceType: 'manual_asset',
      resourceId: existing.id,
      resourceName: existing.name,
    });

    return c.json({ success: true });
  },
);

// POST /devices/manual/:id/link — deviceId XOR discoveredAssetId (enforced by
// the Zod schema). Same-org AND same-site required, mirroring
// discovery.ts's POST /assets/:id/link (:1485,1489). A cross-org target
// resolves to the SAME 404 as a missing target — never leak existence of a
// record in another tenant.
manualRoutes.post(
  '/manual/:id/link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', linkManualAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const body = c.req.valid('json');

    const loaded = await loadAccessibleManualAsset(auth, id);
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const existing = loaded.row;

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
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
        return c.json({ error: 'Device not found' }, 404);
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
        return c.json({ error: 'Discovered asset not found' }, 404);
      }
      targetSiteId = targetAsset.siteId;
      linkUpdate = { linkedDiscoveredAssetId: body.discoveredAssetId, linkedDeviceId: null };
      auditDetails = { linkedDiscoveredAssetId: body.discoveredAssetId };
    }

    if (targetSiteId !== existing.siteId) {
      return c.json(
        {
          error: body.deviceId
            ? 'Device does not belong to the same site as this asset'
            : 'Discovered asset does not belong to the same site as this asset',
        },
        400,
      );
    }

    const [updated] = await db.update(manualAssets)
      .set({ ...linkUpdate, updatedBy: auth.user.id, updatedAt: new Date() })
      .where(eq(manualAssets.id, id))
      .returning();

    // 0-row write despite the prior access-checked load => RLS rejection or a
    // race with a concurrent delete/re-org of this row. Same classification
    // as PATCH and DELETE /:id/link below — a lost race is "not found", not
    // a server fault.
    if (!updated) {
      return c.json({ error: 'Manual asset not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'manual_asset.link',
      resourceType: 'manual_asset',
      resourceId: updated.id,
      resourceName: updated.name,
      details: auditDetails,
    });

    return c.json(toDto(updated));
  },
);

// DELETE /devices/manual/:id/link — clears both link columns unconditionally.
manualRoutes.delete(
  '/manual/:id/link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;

    const loaded = await loadAccessibleManualAsset(auth, id);
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const existing = loaded.row;

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const [updated] = await db.update(manualAssets)
      .set({
        linkedDeviceId: null,
        linkedDiscoveredAssetId: null,
        updatedBy: auth.user.id,
        updatedAt: new Date(),
      })
      .where(eq(manualAssets.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Manual asset not found' }, 404);
    }

    writeRouteAudit(c, {
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

    return c.json(toDto(updated));
  },
);
