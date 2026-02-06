import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import {
  patches,
  devicePatches,
  patchApprovals,
  patchJobs,
  devices
} from '../db/schema';

export const patchRoutes = new Hono();

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

const listPatchesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
  severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional()
});

const patchIdParamSchema = z.object({
  id: z.string().uuid()
});

const scanSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1),
  source: z.string().min(1).max(100).optional()
});

const listSourcesSchema = z.object({
  os: z.enum(['windows', 'macos', 'linux']).optional()
});

const listApprovalsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  status: z.enum(['approved', 'rejected', 'deferred', 'pending']).optional(),
  patchId: z.string().uuid().optional()
});

const approvalActionSchema = z.object({
  note: z.string().max(1000).optional()
});

const deferSchema = z.object({
  deferUntil: z.string().datetime(),
  note: z.string().max(1000).optional()
});

const bulkApproveSchema = z.object({
  patchIds: z.array(z.string().uuid()).min(1),
  note: z.string().max(1000).optional()
});

const complianceSchema = z.object({
  orgId: z.string().uuid().optional(),
  source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
  severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional()
});

const complianceReportSchema = z.object({
  orgId: z.string().uuid().optional(),
  format: z.enum(['csv', 'pdf']).optional()
});

const listJobsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['scheduled', 'running', 'completed', 'failed', 'cancelled']).optional()
});

patchRoutes.use('*', authMiddleware);

// GET /patches - List available patches
patchRoutes.get(
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
    const conditions = [];
    if (query.source) {
      conditions.push(eq(patches.source, query.source));
    }
    if (query.severity) {
      conditions.push(eq(patches.severity, query.severity));
    }
    if (query.os) {
      conditions.push(sql`${query.os} = ANY(${patches.osTypes})`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get patches with optional approval status for the org
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
        createdAt: patches.createdAt
      })
      .from(patches)
      .where(whereClause)
      .orderBy(desc(patches.createdAt))
      .limit(limit)
      .offset(offset);

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(patches)
      .where(whereClause);

    // If org specified, get approval statuses
    let approvalStatuses: Record<string, string> = {};
    if (query.orgId) {
      const approvals = await db
        .select({
          patchId: patchApprovals.patchId,
          status: patchApprovals.status
        })
        .from(patchApprovals)
        .where(eq(patchApprovals.orgId, query.orgId));

      approvalStatuses = Object.fromEntries(
        approvals.map(a => [a.patchId, a.status])
      );
    }

    const data = patchList.map(patch => ({
      ...patch,
      os: patch.osTypes?.[0] || 'unknown',
      approvalStatus: approvalStatuses[patch.id] || 'pending'
    }));

    return c.json({
      data,
      pagination: { page, limit, total: Number(count) }
    });
  }
);

// POST /patches/scan - Trigger patch scan for devices
patchRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', scanSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // TODO: Queue a scan command to the specified devices
    // For now, return success - the agent periodically scans anyway
    return c.json({
      success: true,
      jobId: `scan-${Date.now()}`,
      deviceCount: data.deviceIds.length
    });
  }
);

// GET /patches/sources - List available patch sources
patchRoutes.get(
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

// GET /patches/approvals - List patch approvals for org
patchRoutes.get(
  '/approvals',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listApprovalsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // Check org access
    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const { page, limit, offset } = getPagination(query);

    const conditions = [];
    const orgCond = auth.orgCondition(patchApprovals.orgId);
    if (orgCond) conditions.push(orgCond);
    if (query.orgId) conditions.push(eq(patchApprovals.orgId, query.orgId));
    if (query.status) conditions.push(eq(patchApprovals.status, query.status));
    if (query.patchId) conditions.push(eq(patchApprovals.patchId, query.patchId));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const approvals = await db
      .select()
      .from(patchApprovals)
      .where(whereClause)
      .orderBy(desc(patchApprovals.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(patchApprovals)
      .where(whereClause);

    return c.json({
      data: approvals,
      pagination: { page, limit, total: Number(count) }
    });
  }
);

// POST /patches/bulk-approve - Bulk approve patches
patchRoutes.post(
  '/bulk-approve',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', bulkApproveSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    if (!auth.orgId) {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const approved: string[] = [];
    const failed: string[] = [];

    for (const patchId of data.patchIds) {
      try {
        await db
          .insert(patchApprovals)
          .values({
            orgId: auth.orgId,
            patchId,
            status: 'approved',
            approvedBy: auth.userId,
            approvedAt: new Date(),
            notes: data.note
          })
          .onConflictDoUpdate({
            target: [patchApprovals.orgId, patchApprovals.patchId],
            set: {
              status: 'approved',
              approvedBy: auth.userId,
              approvedAt: new Date(),
              notes: data.note,
              updatedAt: new Date()
            }
          });
        approved.push(patchId);
      } catch {
        failed.push(patchId);
      }
    }

    return c.json({ success: true, approved, failed });
  }
);

// GET /patches/jobs - List patch deployment jobs
patchRoutes.get(
  '/jobs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listJobsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions = [];
    const orgCond = auth.orgCondition(patchJobs.orgId);
    if (orgCond) conditions.push(orgCond);
    if (query.status) conditions.push(eq(patchJobs.status, query.status));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const jobs = await db
      .select()
      .from(patchJobs)
      .where(whereClause)
      .orderBy(desc(patchJobs.createdAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patchJobs)
      .where(whereClause);

    return c.json({
      data: jobs,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// GET /patches/compliance - Get compliance summary
patchRoutes.get(
  '/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', complianceSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    // Get devices scoped to org (or all accessible orgs for partner/system)
    const deviceConditions = [];
    if (query.orgId) {
      deviceConditions.push(eq(devices.orgId, query.orgId));
    } else {
      const orgCond = auth.orgCondition(devices.orgId);
      if (orgCond) {
        deviceConditions.push(orgCond);
      } else if (auth.scope !== 'system') {
        return c.json({ error: 'Organization context required' }, 400);
      }
    }

    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(deviceConditions.length > 0 ? and(...deviceConditions) : undefined);

    const deviceIds = orgDevices.map(d => d.id);

    if (deviceIds.length === 0) {
      return c.json({
        data: {
          summary: { total: 0, pending: 0, installed: 0, failed: 0, missing: 0 },
          compliancePercent: 100
        }
      });
    }

    // Get patch status counts
    const statusCounts = await db
      .select({
        status: devicePatches.status,
        count: sql<number>`count(*)`
      })
      .from(devicePatches)
      .where(inArray(devicePatches.deviceId, deviceIds))
      .groupBy(devicePatches.status);

    const summary = {
      total: 0,
      pending: 0,
      installed: 0,
      failed: 0,
      missing: 0,
      skipped: 0
    };

    for (const row of statusCounts) {
      const count = Number(row.count);
      summary.total += count;
      if (row.status in summary) {
        summary[row.status as keyof typeof summary] = count;
      }
    }

    const compliancePercent = summary.total > 0
      ? Math.round((summary.installed / summary.total) * 100)
      : 100;

    return c.json({
      data: {
        summary,
        compliancePercent,
        filters: {
          source: query.source ?? null,
          severity: query.severity ?? null
        }
      }
    });
  }
);

// GET /patches/compliance/report - Generate compliance report
patchRoutes.get(
  '/compliance/report',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', complianceReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    // TODO: Queue report generation job
    return c.json({
      reportId: `report-${Date.now()}`,
      status: 'queued',
      format: query.format ?? 'csv'
    });
  }
);

// POST /patches/:id/approve - Approve patch
patchRoutes.post(
  '/:id/approve',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (!auth.orgId) {
      return c.json({ error: 'Organization context required' }, 400);
    }

    // Verify patch exists
    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await db
      .insert(patchApprovals)
      .values({
        orgId: auth.orgId,
        patchId: id,
        status: 'approved',
        approvedBy: auth.userId,
        approvedAt: new Date(),
        notes: data.note
      })
      .onConflictDoUpdate({
        target: [patchApprovals.orgId, patchApprovals.patchId],
        set: {
          status: 'approved',
          approvedBy: auth.userId,
          approvedAt: new Date(),
          notes: data.note,
          updatedAt: new Date()
        }
      });

    return c.json({ id, status: 'approved' });
  }
);

// POST /patches/:id/decline - Decline patch
patchRoutes.post(
  '/:id/decline',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (!auth.orgId) {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await db
      .insert(patchApprovals)
      .values({
        orgId: auth.orgId,
        patchId: id,
        status: 'rejected',
        notes: data.note
      })
      .onConflictDoUpdate({
        target: [patchApprovals.orgId, patchApprovals.patchId],
        set: {
          status: 'rejected',
          notes: data.note,
          updatedAt: new Date()
        }
      });

    return c.json({ id, status: 'declined' });
  }
);

// POST /patches/:id/defer - Defer patch to later date
patchRoutes.post(
  '/:id/defer',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', deferSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (!auth.orgId) {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const [patch] = await db
      .select({ id: patches.id })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    await db
      .insert(patchApprovals)
      .values({
        orgId: auth.orgId,
        patchId: id,
        status: 'deferred',
        deferUntil: new Date(data.deferUntil),
        notes: data.note
      })
      .onConflictDoUpdate({
        target: [patchApprovals.orgId, patchApprovals.patchId],
        set: {
          status: 'deferred',
          deferUntil: new Date(data.deferUntil),
          notes: data.note,
          updatedAt: new Date()
        }
      });

    return c.json({
      id,
      status: 'deferred',
      deferUntil: data.deferUntil
    });
  }
);

// GET /patches/:id - Get patch details
patchRoutes.get(
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
