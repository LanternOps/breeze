import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import { queueCommand, queueCommandForExecution } from '../services/commandQueue';
import { writeRouteAudit, type AuthContext } from '../services/auditEvents';
import { enqueuePatchComplianceReport } from '../jobs/patchComplianceReportWorker';
import {
  patches,
  devicePatches,
  patchApprovals,
  patchComplianceReports,
  patchJobs,
  patchRollbacks,
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
  orgId: z.string().uuid().optional(),
  note: z.string().max(1000).optional()
});

const deferSchema = z.object({
  orgId: z.string().uuid().optional(),
  deferUntil: z.string().datetime(),
  note: z.string().max(1000).optional()
});

const rollbackSchema = z.object({
  reason: z.string().max(2000).optional(),
  scheduleType: z.enum(['immediate', 'scheduled']).default('immediate'),
  scheduledTime: z.string().datetime().optional(),
  deviceIds: z.array(z.string().uuid()).optional()
}).superRefine((value, ctx) => {
  if (value.scheduleType === 'scheduled' && !value.scheduledTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduledTime'],
      message: 'scheduledTime is required when scheduleType is scheduled'
    });
  }
});

const bulkApproveSchema = z.object({
  orgId: z.string().uuid().optional(),
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
  source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
  severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
  format: z.enum(['csv', 'pdf']).optional()
});

const listJobsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['scheduled', 'running', 'completed', 'failed', 'cancelled']).optional()
});

function inferPatchOs(
  osTypes: string[] | null,
  source: string,
  inferredOs?: string | null
): 'windows' | 'macos' | 'linux' | 'unknown' {
  if (Array.isArray(osTypes) && osTypes.length > 0) {
    const candidate = String(osTypes[0]).toLowerCase();
    if (candidate === 'windows' || candidate === 'macos' || candidate === 'linux') {
      return candidate;
    }
  }

  if (typeof inferredOs === 'string') {
    const candidate = inferredOs.toLowerCase();
    if (candidate === 'windows' || candidate === 'macos' || candidate === 'linux') {
      return candidate;
    }
  }

  switch (source) {
    case 'microsoft':
      return 'windows';
    case 'apple':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

patchRoutes.use('*', authMiddleware);

function writePatchAuditForOrgIds(
  c: AuthContext,
  orgIds: string[] | Set<string> | string | null | undefined,
  event: {
    action: string;
    resourceType: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
  }
): void {
  const orgIdList = Array.isArray(orgIds)
    ? orgIds
    : (typeof orgIds === 'string'
      ? [orgIds]
      : (orgIds ? Array.from(orgIds) : []));
  const uniqueOrgIds = [...new Set(orgIdList.filter(Boolean))];
  for (const orgId of uniqueOrgIds) {
    writeRouteAudit(c, { orgId, ...event });
  }
}

function resolvePatchApprovalOrgId(
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

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0]! };
  }

  if (auth.scope === 'partner' || auth.scope === 'system') {
    return { error: 'orgId is required for partner/system scope', status: 400 };
  }

  return { error: 'Organization context required', status: 400 };
}

function resolvePatchReportOrgId(
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

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0]! };
  }

  return { error: 'orgId is required when multiple organizations are accessible', status: 400 };
}

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
      os: inferPatchOs(patch.osTypes, patch.source, patch.inferredOs),
      approvalStatus: approvalStatuses[patch.id] || 'pending'
    }));

    return c.json({
      data,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
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

    const requestedDevices = await db
      .select({
        id: devices.id,
        orgId: devices.orgId
      })
      .from(devices)
      .where(inArray(devices.id, data.deviceIds));

    const foundDeviceIDs = new Set(requestedDevices.map((d) => d.id));
    const missingDeviceIDs = data.deviceIds.filter((id) => !foundDeviceIDs.has(id));

    const accessibleDevices = requestedDevices.filter((device) => auth.canAccessOrg(device.orgId));
    const inaccessibleDeviceIDs = requestedDevices
      .filter((device) => !auth.canAccessOrg(device.orgId))
      .map((device) => device.id);

    const queueResults = await Promise.all(
      accessibleDevices.map(async (device) => {
        try {
          const queued = await queueCommandForExecution(
            device.id,
            'patch_scan',
            { source: data.source ?? null },
            {
              userId: auth.user.id,
              preferHeartbeat: false
            }
          );

          if (!queued.command) {
            return { ok: false as const, deviceId: device.id };
          }

          return {
            ok: true as const,
            commandId: queued.command.id,
            commandStatus: queued.command.status
          };
        } catch {
          return { ok: false as const, deviceId: device.id };
        }
      })
    );

    const queuedCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string } => r.ok)
      .map((r) => r.commandId);
    const dispatchedCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok && r.commandStatus === 'sent')
      .map((r) => r.commandId);
    const pendingCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok && r.commandStatus !== 'sent')
      .map((r) => r.commandId);
    const failedDeviceIDs = queueResults
      .filter((r): r is { ok: false; deviceId: string } => !r.ok)
      .map((r) => r.deviceId);

    writePatchAuditForOrgIds(
      c,
      accessibleDevices.map((d) => d.orgId),
      {
        action: 'patch.scan.trigger',
        resourceType: 'patch',
        details: {
          source: data.source ?? null,
          deviceCount: accessibleDevices.length,
          queuedCommandIds,
          dispatchedCommandIds,
          pendingCommandIds,
          failedDeviceIds: failedDeviceIDs
        }
      }
    );

    return c.json({
      success: failedDeviceIDs.length === 0,
      jobId: `scan-${Date.now()}`,
      deviceCount: accessibleDevices.length,
      queuedCommandIds,
      dispatchedCommandIds,
      pendingCommandIds,
      failedDeviceIds: failedDeviceIDs,
      skipped: {
        missingDeviceIds: missingDeviceIDs,
        inaccessibleDeviceIds: inaccessibleDeviceIDs
      }
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

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patchApprovals)
      .where(whereClause);

    return c.json({
      data: approvals,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
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

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

    const approved: string[] = [];
    const failed: string[] = [];

    for (const patchId of data.patchIds) {
      try {
        await db
          .insert(patchApprovals)
          .values({
            orgId: targetOrgId,
            patchId,
            status: 'approved',
            approvedBy: auth.user.id,
            approvedAt: new Date(),
            notes: data.note
          })
          .onConflictDoUpdate({
            target: [patchApprovals.orgId, patchApprovals.patchId],
            set: {
              status: 'approved',
              approvedBy: auth.user.id,
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

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.bulk_approve',
      resourceType: 'patch',
      details: {
        approvedCount: approved.length,
        failedCount: failed.length,
        patchIds: data.patchIds
      }
    });

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
    const complianceConditions = [inArray(devicePatches.deviceId, deviceIds)];
    if (query.source) {
      complianceConditions.push(eq(patches.source, query.source));
    }
    if (query.severity) {
      complianceConditions.push(eq(patches.severity, query.severity));
    }

    const statusCounts = await db
      .select({
        status: devicePatches.status,
        count: sql<number>`count(*)`
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(and(...complianceConditions))
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

    const orgResolution = resolvePatchReportOrgId(auth, query.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

    const [report] = await db
      .insert(patchComplianceReports)
      .values({
        orgId: targetOrgId,
        requestedBy: auth.user.id,
        source: query.source ?? null,
        severity: query.severity ?? null,
        format: query.format ?? 'csv',
        status: 'pending'
      })
      .returning({
        id: patchComplianceReports.id,
        orgId: patchComplianceReports.orgId,
        status: patchComplianceReports.status,
        format: patchComplianceReports.format
      });

    if (!report) {
      return c.json({ error: 'Failed to create compliance report request' }, 500);
    }

    await enqueuePatchComplianceReport(report.id);

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.compliance.report.queue',
      resourceType: 'patch_compliance_report',
      resourceId: report.id,
      details: {
        format: report.format,
        source: query.source ?? null,
        severity: query.severity ?? null
      }
    });

    return c.json({
      reportId: report.id,
      status: 'queued',
      format: report.format,
      source: query.source ?? null,
      severity: query.severity ?? null
    });
  }
);

// GET /patches/compliance/report/:id - Report status
patchRoutes.get(
  '/compliance/report/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

    const [report] = await db
      .select({
        id: patchComplianceReports.id,
        orgId: patchComplianceReports.orgId,
        status: patchComplianceReports.status,
        format: patchComplianceReports.format,
        source: patchComplianceReports.source,
        severity: patchComplianceReports.severity,
        summary: patchComplianceReports.summary,
        rowCount: patchComplianceReports.rowCount,
        errorMessage: patchComplianceReports.errorMessage,
        startedAt: patchComplianceReports.startedAt,
        completedAt: patchComplianceReports.completedAt,
        createdAt: patchComplianceReports.createdAt,
        outputPath: patchComplianceReports.outputPath
      })
      .from(patchComplianceReports)
      .where(eq(patchComplianceReports.id, reportId))
      .limit(1);

    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    if (!auth.canAccessOrg(report.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    return c.json({
      data: {
        id: report.id,
        status: report.status,
        format: report.format,
        source: report.source,
        severity: report.severity,
        summary: report.summary,
        rowCount: report.rowCount,
        errorMessage: report.errorMessage,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        createdAt: report.createdAt,
        downloadUrl: report.outputPath
          ? `/api/v1/patches/compliance/report/${report.id}/download`
          : null
      }
    });
  }
);

// GET /patches/compliance/report/:id/download - Download completed report file
patchRoutes.get(
  '/compliance/report/:id/download',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

    const [report] = await db
      .select({
        id: patchComplianceReports.id,
        orgId: patchComplianceReports.orgId,
        status: patchComplianceReports.status,
        format: patchComplianceReports.format,
        outputPath: patchComplianceReports.outputPath
      })
      .from(patchComplianceReports)
      .where(eq(patchComplianceReports.id, reportId))
      .limit(1);

    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    if (!auth.canAccessOrg(report.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    if (report.status !== 'completed') {
      return c.json({ error: 'Report is not ready for download' }, 409);
    }

    if (!report.outputPath) {
      return c.json({ error: 'Report output is unavailable' }, 404);
    }

    try {
      const file = await readFile(report.outputPath);
      const extension = report.format === 'pdf' ? 'pdf' : 'csv';
      const contentType = report.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8';

      c.header('Content-Type', contentType);
      c.header('Content-Disposition', `attachment; filename=\"patch-compliance-${report.id}.${extension}\"`);
      c.header('Cache-Control', 'no-store');

      return c.body(file);
    } catch {
      return c.json({ error: 'Report file not found' }, 404);
    }
  }
);

// POST /patches/:id/rollback - Queue rollback commands for a patch
patchRoutes.post(
  '/:id/rollback',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', rollbackSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (data.scheduleType === 'scheduled') {
      return c.json({ error: 'Scheduled rollback is not supported yet' }, 400);
    }

    const [patch] = await db
      .select({
        id: patches.id,
        source: patches.source,
        externalId: patches.externalId,
        title: patches.title
      })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    let candidateDevices: Array<{ id: string; orgId: string }> = [];
    let missingDeviceIds: string[] = [];

    if (data.deviceIds && data.deviceIds.length > 0) {
      candidateDevices = await db
        .select({
          id: devices.id,
          orgId: devices.orgId
        })
        .from(devices)
        .where(inArray(devices.id, data.deviceIds));

      const foundIds = new Set(candidateDevices.map((device) => device.id));
      missingDeviceIds = data.deviceIds.filter((deviceId) => !foundIds.has(deviceId));
    } else {
      candidateDevices = await db
        .select({
          id: devices.id,
          orgId: devices.orgId
        })
        .from(devicePatches)
        .innerJoin(devices, eq(devicePatches.deviceId, devices.id))
        .where(
          and(
            eq(devicePatches.patchId, id),
            eq(devicePatches.status, 'installed')
          )
        );
    }

    const accessibleDevices = candidateDevices.filter((device) => auth.canAccessOrg(device.orgId));
    const inaccessibleDeviceIds = candidateDevices
      .filter((device) => !auth.canAccessOrg(device.orgId))
      .map((device) => device.id);

    if (accessibleDevices.length === 0) {
      return c.json({
        error: 'No accessible devices found for rollback',
        skipped: {
          missingDeviceIds,
          inaccessibleDeviceIds
        }
      }, 404);
    }

    const queueResults = await Promise.all(
      accessibleDevices.map(async (device) => {
        try {
          const command = await queueCommand(
            device.id,
            'rollback_patches',
            {
              patchIds: [id],
              patches: [patch],
              reason: data.reason ?? null
            },
            auth.user.id
          );

          return { ok: true as const, deviceId: device.id, commandId: command.id };
        } catch {
          return { ok: false as const, deviceId: device.id };
        }
      })
    );

    const queued = queueResults.filter((result): result is { ok: true; deviceId: string; commandId: string } => result.ok);
    const failedDeviceIds = queueResults
      .filter((result): result is { ok: false; deviceId: string } => !result.ok)
      .map((result) => result.deviceId);

    if (queued.length > 0) {
      await db
        .insert(patchRollbacks)
        .values(
          queued.map((entry) => ({
            deviceId: entry.deviceId,
            patchId: id,
            reason: data.reason ?? null,
            status: 'pending' as const,
            initiatedBy: auth.user.id
          }))
        );
    }

    writePatchAuditForOrgIds(
      c,
      accessibleDevices.map((d) => d.orgId),
      {
        action: 'patch.rollback',
        resourceType: 'patch',
        resourceId: id,
        resourceName: patch.title,
        details: {
          queuedCommandIds: queued.map((entry) => entry.commandId),
          deviceCount: accessibleDevices.length,
          failedDeviceIds,
          reason: data.reason ?? null
        }
      }
    );

    return c.json({
      success: failedDeviceIds.length === 0,
      patchId: id,
      queuedCommandIds: queued.map((entry) => entry.commandId),
      deviceCount: accessibleDevices.length,
      failedDeviceIds,
      skipped: {
        missingDeviceIds,
        inaccessibleDeviceIds
      }
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

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

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
        orgId: targetOrgId,
        patchId: id,
        status: 'approved',
        approvedBy: auth.user.id,
        approvedAt: new Date(),
        notes: data.note
      })
      .onConflictDoUpdate({
        target: [patchApprovals.orgId, patchApprovals.patchId],
        set: {
          status: 'approved',
          approvedBy: auth.user.id,
          approvedAt: new Date(),
          notes: data.note,
          updatedAt: new Date()
        }
      });

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.approve',
      resourceType: 'patch',
      resourceId: id,
      details: {
        note: data.note ?? null
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

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

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
        orgId: targetOrgId,
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

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.decline',
      resourceType: 'patch',
      resourceId: id,
      details: {
        note: data.note ?? null
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

    const orgResolution = resolvePatchApprovalOrgId(auth, data.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

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
        orgId: targetOrgId,
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

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.defer',
      resourceType: 'patch',
      resourceId: id,
      details: {
        deferUntil: data.deferUntil,
        note: data.note ?? null
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
