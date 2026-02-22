import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, asc, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  patchPolicies,
  patchApprovals,
  patchJobs,
  patchComplianceSnapshots,
  patches,
  devicePatches,
  devices
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const updateRingRoutes = new Hono();

updateRingRoutes.use('*', authMiddleware);

// ============================================
// Helpers
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function resolveOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    accessibleOrgIds: string[] | null;
    canAccessOrg: (orgId: string) => boolean;
  },
  requestedOrgId?: string
): { orgId: string } | { error: string; status: 400 | 403 } {
  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied to this organization', status: 403 };
    }
    return { orgId: requestedOrgId };
  }
  if (auth.orgId) return { orgId: auth.orgId };
  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0]! };
  }
  return { error: 'orgId is required', status: 400 };
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

async function ensureDefaultRing(orgId: string, userId?: string): Promise<string> {
  // Check if a default ring already exists
  const [existing] = await db
    .select({ id: patchPolicies.id })
    .from(patchPolicies)
    .where(
      and(
        eq(patchPolicies.orgId, orgId),
        eq(patchPolicies.ringOrder, 0),
        eq(patchPolicies.name, 'Default')
      )
    )
    .limit(1);

  if (existing) return existing.id;

  // Auto-create default ring
  const [created] = await db
    .insert(patchPolicies)
    .values({
      orgId,
      name: 'Default',
      description: 'Default update ring — all patches require manual approval',
      enabled: true,
      targets: {},
      autoApprove: {},
      schedule: {},
      rebootPolicy: {},
      categoryRules: [],
      ringOrder: 0,
      deferralDays: 0,
      deadlineDays: null,
      gracePeriodHours: 4,
      categories: [],
      excludeCategories: [],
      createdBy: userId ?? null,
    })
    .returning({ id: patchPolicies.id });

  return created!.id;
}

// ============================================
// Schemas
// ============================================

const listRingsSchema = z.object({
  orgId: z.string().uuid().optional(),
});

const categoryRuleSchema = z.object({
  category: z.string().max(100),
  autoApprove: z.boolean(),
  autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
  deferralDaysOverride: z.number().int().min(0).max(365).nullable().optional(),
});

const createRingSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  ringOrder: z.number().int().min(0).max(100).optional(),
  deferralDays: z.number().int().min(0).max(365).optional(),
  deadlineDays: z.number().int().min(0).max(365).nullable().optional(),
  gracePeriodHours: z.number().int().min(0).max(168).optional(),
  categories: z.array(z.string().max(100)).optional(),
  excludeCategories: z.array(z.string().max(100)).optional(),
  categoryRules: z.array(categoryRuleSchema).optional(),
  sources: z.array(z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom'])).optional(),
  autoApprove: z.record(z.unknown()).optional(),
  targets: z.record(z.unknown()).optional(),
});

const updateRingSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  ringOrder: z.number().int().min(0).max(100).optional(),
  deferralDays: z.number().int().min(0).max(365).optional(),
  deadlineDays: z.number().int().min(0).max(365).nullable().optional(),
  gracePeriodHours: z.number().int().min(0).max(168).optional(),
  categories: z.array(z.string().max(100)).optional(),
  excludeCategories: z.array(z.string().max(100)).optional(),
  categoryRules: z.array(categoryRuleSchema).optional(),
  sources: z.array(z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom'])).optional(),
  autoApprove: z.record(z.unknown()).optional(),
  targets: z.record(z.unknown()).optional(),
});

const ringIdParamSchema = z.object({
  id: z.string().uuid(),
});

const ringPatchesQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
  severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
});

// ============================================
// Routes
// ============================================

// GET /update-rings — List rings sorted by ringOrder
updateRingRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listRingsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    // Ensure default ring exists
    await ensureDefaultRing(orgId, auth.user.id);

    const rings = await db
      .select({
        id: patchPolicies.id,
        name: patchPolicies.name,
        description: patchPolicies.description,
        enabled: patchPolicies.enabled,
        ringOrder: patchPolicies.ringOrder,
        deferralDays: patchPolicies.deferralDays,
        deadlineDays: patchPolicies.deadlineDays,
        gracePeriodHours: patchPolicies.gracePeriodHours,
        categories: patchPolicies.categories,
        excludeCategories: patchPolicies.excludeCategories,
        sources: patchPolicies.sources,
        autoApprove: patchPolicies.autoApprove,
        categoryRules: patchPolicies.categoryRules,
        targets: patchPolicies.targets,
        createdAt: patchPolicies.createdAt,
        updatedAt: patchPolicies.updatedAt,
      })
      .from(patchPolicies)
      .where(and(eq(patchPolicies.orgId, orgId), eq(patchPolicies.enabled, true)))
      .orderBy(asc(patchPolicies.ringOrder), asc(patchPolicies.createdAt));

    return c.json({ data: rings });
  }
);

// POST /update-rings — Create ring
updateRingRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createRingSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const orgResult = resolveOrgId(auth, data.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const [ring] = await db
      .insert(patchPolicies)
      .values({
        orgId,
        name: data.name,
        description: data.description ?? null,
        enabled: data.enabled ?? true,
        ringOrder: data.ringOrder ?? 0,
        deferralDays: data.deferralDays ?? 0,
        deadlineDays: data.deadlineDays ?? null,
        gracePeriodHours: data.gracePeriodHours ?? 4,
        categories: data.categories ?? [],
        excludeCategories: data.excludeCategories ?? [],
        sources: data.sources ?? null,
        autoApprove: data.autoApprove ?? {},
        categoryRules: data.categoryRules ?? [],
        targets: data.targets ?? {},
        createdBy: auth.user.id,
      })
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'update_ring.create',
      resourceType: 'update_ring',
      resourceId: ring!.id,
      resourceName: data.name,
      details: { ringOrder: ring!.ringOrder, deferralDays: ring!.deferralDays },
    });

    return c.json(ring, 201);
  }
);

// GET /update-rings/:id — Ring detail + compliance summary
updateRingRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', ringIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const [ring] = await db
      .select()
      .from(patchPolicies)
      .where(eq(patchPolicies.id, id))
      .limit(1);

    if (!ring) return c.json({ error: 'Update ring not found' }, 404);
    if (!auth.canAccessOrg(ring.orgId)) return c.json({ error: 'Access denied' }, 403);

    // Get approval counts for this ring
    const approvalCounts = await db
      .select({
        status: patchApprovals.status,
        count: sql<number>`count(*)`,
      })
      .from(patchApprovals)
      .where(and(eq(patchApprovals.orgId, ring.orgId), eq(patchApprovals.ringId, id)))
      .groupBy(patchApprovals.status);

    const approvalSummary: Record<string, number> = {};
    for (const row of approvalCounts) {
      approvalSummary[row.status] = Number(row.count);
    }

    // Get recent jobs for this ring
    const recentJobs = await db
      .select({
        id: patchJobs.id,
        name: patchJobs.name,
        status: patchJobs.status,
        devicesTotal: patchJobs.devicesTotal,
        devicesCompleted: patchJobs.devicesCompleted,
        devicesFailed: patchJobs.devicesFailed,
        createdAt: patchJobs.createdAt,
      })
      .from(patchJobs)
      .where(eq(patchJobs.ringId, id))
      .orderBy(desc(patchJobs.createdAt))
      .limit(5);

    return c.json({
      ...ring,
      approvalSummary,
      recentJobs,
    });
  }
);

// PATCH /update-rings/:id — Update ring
updateRingRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', ringIdParamSchema),
  zValidator('json', updateRingSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const [existing] = await db
      .select({ id: patchPolicies.id, orgId: patchPolicies.orgId })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, id))
      .limit(1);

    if (!existing) return c.json({ error: 'Update ring not found' }, 404);
    if (!auth.canAccessOrg(existing.orgId)) return c.json({ error: 'Access denied' }, 403);

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateFields.name = data.name;
    if (data.description !== undefined) updateFields.description = data.description;
    if (data.enabled !== undefined) updateFields.enabled = data.enabled;
    if (data.ringOrder !== undefined) updateFields.ringOrder = data.ringOrder;
    if (data.deferralDays !== undefined) updateFields.deferralDays = data.deferralDays;
    if (data.deadlineDays !== undefined) updateFields.deadlineDays = data.deadlineDays;
    if (data.gracePeriodHours !== undefined) updateFields.gracePeriodHours = data.gracePeriodHours;
    if (data.categories !== undefined) updateFields.categories = data.categories;
    if (data.excludeCategories !== undefined) updateFields.excludeCategories = data.excludeCategories;
    if (data.sources !== undefined) updateFields.sources = data.sources;
    if (data.autoApprove !== undefined) updateFields.autoApprove = data.autoApprove;
    if (data.categoryRules !== undefined) updateFields.categoryRules = data.categoryRules;
    if (data.targets !== undefined) updateFields.targets = data.targets;

    const [updated] = await db
      .update(patchPolicies)
      .set(updateFields)
      .where(eq(patchPolicies.id, id))
      .returning();

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'update_ring.update',
      resourceType: 'update_ring',
      resourceId: id,
      details: { changes: Object.keys(data) },
    });

    return c.json(updated);
  }
);

// DELETE /update-rings/:id — Soft delete (enabled=false)
updateRingRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', ringIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const [existing] = await db
      .select({ id: patchPolicies.id, orgId: patchPolicies.orgId, name: patchPolicies.name })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, id))
      .limit(1);

    if (!existing) return c.json({ error: 'Update ring not found' }, 404);
    if (!auth.canAccessOrg(existing.orgId)) return c.json({ error: 'Access denied' }, 403);

    await db
      .update(patchPolicies)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(patchPolicies.id, id));

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'update_ring.delete',
      resourceType: 'update_ring',
      resourceId: id,
      resourceName: existing.name,
    });

    return c.json({ success: true });
  }
);

// GET /update-rings/:id/patches — Patches with ring-scoped approval status
updateRingRoutes.get(
  '/:id/patches',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', ringIdParamSchema),
  zValidator('query', ringPatchesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');

    const [ring] = await db
      .select({ id: patchPolicies.id, orgId: patchPolicies.orgId })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, id))
      .limit(1);

    if (!ring) return c.json({ error: 'Update ring not found' }, 404);
    if (!auth.canAccessOrg(ring.orgId)) return c.json({ error: 'Access denied' }, 403);

    const { page, limit, offset } = getPagination(query);

    const conditions = [];
    if (query.source) conditions.push(eq(patches.source, query.source));
    if (query.severity) conditions.push(eq(patches.severity, query.severity));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const patchList = await db
      .select({
        id: patches.id,
        title: patches.title,
        description: patches.description,
        source: patches.source,
        severity: patches.severity,
        category: patches.category,
        osTypes: patches.osTypes,
        releaseDate: patches.releaseDate,
        requiresReboot: patches.requiresReboot,
        downloadSizeMb: patches.downloadSizeMb,
        createdAt: patches.createdAt,
      })
      .from(patches)
      .where(whereClause)
      .orderBy(desc(patches.createdAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patches)
      .where(whereClause);

    // Get ring-scoped approval statuses
    const patchIdsInPage = patchList.map((p) => p.id);
    let ringApprovals: Record<string, string> = {};

    if (patchIdsInPage.length > 0) {
      const approvals = await db
        .select({
          patchId: patchApprovals.patchId,
          status: patchApprovals.status,
        })
        .from(patchApprovals)
        .where(
          and(
            eq(patchApprovals.orgId, ring.orgId),
            eq(patchApprovals.ringId, id),
            inArray(patchApprovals.patchId, patchIdsInPage)
          )
        );

      ringApprovals = Object.fromEntries(approvals.map((a) => [a.patchId, a.status]));
    }

    const data = patchList.map((patch) => ({
      ...patch,
      approvalStatus: ringApprovals[patch.id] || 'pending',
    }));

    return c.json({
      data,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) },
    });
  }
);

// GET /update-rings/:id/compliance — Ring-specific compliance
updateRingRoutes.get(
  '/:id/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', ringIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const [ring] = await db
      .select({ id: patchPolicies.id, orgId: patchPolicies.orgId, name: patchPolicies.name })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, id))
      .limit(1);

    if (!ring) return c.json({ error: 'Update ring not found' }, 404);
    if (!auth.canAccessOrg(ring.orgId)) return c.json({ error: 'Access denied' }, 403);

    // Get devices in org
    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.orgId, ring.orgId));
    const deviceIds = orgDevices.map((d) => d.id);

    if (deviceIds.length === 0) {
      return c.json({
        data: {
          ringId: id,
          ringName: ring.name,
          summary: { total: 0, pending: 0, installed: 0, failed: 0, missing: 0 },
          compliancePercent: 100,
        },
      });
    }

    // Get ring-approved patch IDs
    const approvedPatches = await db
      .select({ patchId: patchApprovals.patchId })
      .from(patchApprovals)
      .where(
        and(
          eq(patchApprovals.orgId, ring.orgId),
          eq(patchApprovals.ringId, id),
          eq(patchApprovals.status, 'approved')
        )
      );

    const approvedPatchIds = approvedPatches.map((a) => a.patchId);

    if (approvedPatchIds.length === 0) {
      return c.json({
        data: {
          ringId: id,
          ringName: ring.name,
          summary: { total: 0, pending: 0, installed: 0, failed: 0, missing: 0 },
          compliancePercent: 100,
          approvedPatches: 0,
        },
      });
    }

    // Get device patch status for ring-approved patches
    const statusCounts = await db
      .select({
        status: devicePatches.status,
        count: sql<number>`count(*)`,
      })
      .from(devicePatches)
      .where(
        and(
          inArray(devicePatches.deviceId, deviceIds),
          inArray(devicePatches.patchId, approvedPatchIds)
        )
      )
      .groupBy(devicePatches.status);

    const summary = { total: 0, pending: 0, installed: 0, failed: 0, missing: 0, skipped: 0 };
    for (const row of statusCounts) {
      const count = Number(row.count);
      summary.total += count;
      if (row.status in summary) {
        summary[row.status as keyof typeof summary] = count;
      }
    }

    const compliancePercent =
      summary.total > 0 ? Math.round((summary.installed / summary.total) * 100) : 100;

    return c.json({
      data: {
        ringId: id,
        ringName: ring.name,
        summary,
        compliancePercent,
        approvedPatches: approvedPatchIds.length,
        totalDevices: deviceIds.length,
      },
    });
  }
);
