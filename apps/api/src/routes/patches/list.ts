import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, type SQL } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { patches, patchApprovals, devices, devicePatches } from '../../db/schema';
import { listPatchesSchema, listSourcesSchema, patchIdParamSchema } from './schemas';
import { getPagination, inferPatchOs } from './helpers';

export const listRoutes = new Hono();

// GET /patches - List available patches
listRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPatchesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // Check org access if specified
    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const { page, limit, offset } = getPagination(query);

    // Build conditions
    const conditions: SQL[] = [];
    let sourcePredicate: SQL | undefined;
    if (query.source) {
      sourcePredicate = eq(patches.source, query.source);
      conditions.push(sourcePredicate);
    }
    if (query.severity) {
      conditions.push(eq(patches.severity, query.severity));
    }
    if (query.os) {
      conditions.push(sql`${sql.param(query.os)} = ANY(${patches.osTypes})`);
    }

    // Org scoping. The `patches` table is a global vendor-published catalog
    // with no `org_id` column — the only way "patches for org X" is meaningful
    // is via the device_patches join showing which patches are present on
    // devices in that org. When the caller passes `?orgId=<uuid>`, narrow to
    // patches present on devices in that org via EXISTS. Without an explicit
    // orgId we preserve the prior behavior (full catalog for partner/system
    // scope) to keep this change minimum-risk; a follow-up can decide whether
    // partner-no-orgId callers should also auto-narrow.
    if (query.orgId) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${devicePatches} dp
        INNER JOIN ${devices} d ON d.id = dp.device_id
        WHERE dp.patch_id = ${patches.id} AND d.org_id = ${query.orgId}
      )`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get patches with optional approval status for the org
    const patchList = await db
      .select({
        id: patches.id,
        title: patches.title,
        description: patches.description,
        source: patches.source,
        vendor: patches.vendor,
        packageId: patches.packageId,
        version: patches.version,
        cveIds: patches.cveIds,
        severity: patches.severity,
        category: patches.category,
        osTypes: patches.osTypes,
        inferredOs: sql<string | null>`(
          SELECT "devices"."os_type"
          FROM "device_patches"
          INNER JOIN "devices" ON "devices"."id" = "device_patches"."device_id"
          WHERE "device_patches"."patch_id" = "patches"."id"
          ORDER BY "device_patches"."last_checked_at" DESC NULLS LAST
          LIMIT 1
        )`,
        releaseDate: patches.releaseDate,
        requiresReboot: patches.requiresReboot,
        downloadSizeMb: patches.downloadSizeMb,
        createdAt: patches.createdAt
      })
      .from(patches)
      .where(whereClause)
      .orderBy(desc(patches.createdAt))
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patches)
      .where(whereClause);

    // Per-source counts (ignores the source filter so the chips reflect
    // the full breakdown of all visible patches).
    const sourceConditions = conditions.filter((c) => c !== sourcePredicate);
    const sourceWhereClause = sourceConditions.length > 0 ? and(...sourceConditions) : undefined;
    const sourceCounts = await db
      .select({ source: patches.source, count: sql<number>`count(*)::int` })
      .from(patches)
      .where(sourceWhereClause)
      .groupBy(patches.source);
    const counts: Record<string, number> = {
      microsoft: 0,
      apple: 0,
      linux: 0,
      third_party: 0,
      custom: 0,
    };
    for (const row of sourceCounts) counts[row.source] = Number(row.count);

    // If org specified, get approval statuses (optionally ring-scoped)
    let approvalStatuses: Record<string, string> = {};
    if (query.orgId) {
      const approvalConditions = [eq(patchApprovals.orgId, query.orgId)];
      if (query.ringId) {
        approvalConditions.push(eq(patchApprovals.ringId, query.ringId));
      }

      const approvals = await db
        .select({
          patchId: patchApprovals.patchId,
          status: patchApprovals.status
        })
        .from(patchApprovals)
        .where(and(...approvalConditions));

      approvalStatuses = Object.fromEntries(
        approvals.map(a => [a.patchId, a.status])
      );
    }

    const data = patchList.map(patch => ({
      ...patch,
      os: inferPatchOs(patch.osTypes, patch.source, patch.inferredOs),
      approvalStatus: approvalStatuses[patch.id] || 'pending'
    }));

    return c.json({
      data,
      counts,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// GET /patches/sources - List available patch sources
listRoutes.get(
  '/sources',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listSourcesSchema),
  async (c) => {
    const sources = [
      { id: 'microsoft', name: 'Microsoft Windows Update', os: 'windows' },
      { id: 'apple', name: 'Apple Software Update', os: 'macos' },
      { id: 'linux', name: 'Linux Package Manager', os: 'linux' },
      { id: 'third_party', name: 'Third Party', os: null },
      { id: 'custom', name: 'Custom', os: null }
    ];

    const query = c.req.valid('query');
    const filtered = query.os
      ? sources.filter(s => s.os === query.os || s.os === null)
      : sources;

    return c.json({ data: filtered });
  }
);

// GET /patches/:id - Get patch details
listRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');

    const [patch] = await db
      .select()
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    return c.json(patch);
  }
);
