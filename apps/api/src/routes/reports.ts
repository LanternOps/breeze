import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  reports,
  reportRuns,
  devices,
  deviceSoftware,
  deviceMetrics,
  deviceHardware,
  alerts,
  alertRules,
  organizations,
  sites
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const reportRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getReportWithOrgCheck(reportId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [report] = await db
    .select()
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);

  if (!report) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(report.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return report;
}

async function getReportRunWithOrgCheck(runId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [run] = await db
    .select({
      id: reportRuns.id,
      reportId: reportRuns.reportId,
      status: reportRuns.status,
      startedAt: reportRuns.startedAt,
      completedAt: reportRuns.completedAt,
      outputUrl: reportRuns.outputUrl,
      errorMessage: reportRuns.errorMessage,
      rowCount: reportRuns.rowCount,
      createdAt: reportRuns.createdAt,
      orgId: reports.orgId
    })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(eq(reportRuns.id, runId))
    .limit(1);

  if (!run) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(run.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return run;
}

async function getOrgIdsForAuth(auth: { scope: string; partnerId: string | null; orgId: string | null }): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId as string));
    return partnerOrgs.map(o => o.id);
  }

  // system scope - return null to indicate no filtering needed
  return null;
}

// Validation schemas
const listReportsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  type: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']).optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional()
});

const createReportSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']),
  config: z.object({
    dateRange: z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional()
    }).optional(),
    filters: z.object({
      siteIds: z.array(z.string().uuid()).optional(),
      deviceIds: z.array(z.string().uuid()).optional(),
      osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
      status: z.array(z.string()).optional(),
      severity: z.array(z.string()).optional()
    }).optional(),
    columns: z.array(z.string()).optional(),
    groupBy: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional()
  }).optional().default({}),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).default('one_time'),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv')
});

const updateReportSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.any().optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional(),
  format: z.enum(['csv', 'pdf', 'excel']).optional()
});

const generateReportSchema = z.object({
  type: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']),
  config: z.object({
    dateRange: z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional()
    }).optional(),
    filters: z.object({
      siteIds: z.array(z.string().uuid()).optional(),
      deviceIds: z.array(z.string().uuid()).optional(),
      osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
      status: z.array(z.string()).optional(),
      severity: z.array(z.string()).optional()
    }).optional()
  }).optional().default({}),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv'),
  orgId: z.string().uuid().optional()
});

const listRunsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  reportId: z.string().uuid().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional()
});

const dataQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

// Apply auth middleware to all routes
reportRoutes.use('*', authMiddleware);

// ============================================
// REPORT MANAGEMENT ENDPOINTS
// ============================================

// GET /reports - List saved reports
reportRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listReportsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(reports.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(reports.orgId, query.orgId));
      } else {
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(reports.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(reports.orgId, query.orgId));
    }

    // Additional filters
    if (query.type) {
      conditions.push(eq(reports.type, query.type));
    }

    if (query.schedule) {
      conditions.push(eq(reports.schedule, query.schedule));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(reports)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get reports
    const reportsList = await db
      .select()
      .from(reports)
      .where(whereCondition)
      .orderBy(desc(reports.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: reportsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /reports/:id - Get report config
reportRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

    // Skip if this is a route like /reports/runs, /reports/data, etc.
    if (['runs', 'data', 'generate'].includes(reportId)) {
      return c.notFound();
    }

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // Get recent runs for this report
    const recentRuns = await db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.reportId, reportId))
      .orderBy(desc(reportRuns.createdAt))
      .limit(5);

    return c.json({
      ...report,
      recentRuns
    });
  }
);

// POST /reports - Create report definition
reportRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [report] = await db
      .insert(reports)
      .values({
        orgId: orgId!,
        name: data.name,
        type: data.type,
        config: data.config,
        schedule: data.schedule,
        format: data.format,
        createdBy: auth.user.id
      })
      .returning();

    return c.json(report, 201);
  }
);

// PUT /reports/:id - Update report
reportRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.config !== undefined) updates.config = data.config;
    if (data.schedule !== undefined) updates.schedule = data.schedule;
    if (data.format !== undefined) updates.format = data.format;

    const [updated] = await db
      .update(reports)
      .set(updates)
      .where(eq(reports.id, reportId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /reports/:id - Delete report
reportRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // Delete associated runs first
    await db
      .delete(reportRuns)
      .where(eq(reportRuns.reportId, reportId));

    // Delete the report
    await db
      .delete(reports)
      .where(eq(reports.id, reportId));

    return c.json({ success: true });
  }
);

// POST /reports/:id/generate - Generate report now
reportRoutes.post(
  '/:id/generate',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id');

    const report = await getReportWithOrgCheck(reportId, auth);
    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    // Create a new report run
    const [run] = await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'pending',
        startedAt: new Date()
      })
      .returning();

    if (!run) {
      return c.json({ error: 'Failed to create report run' }, 500);
    }

    // In a real implementation, this would trigger an async job
    // For now, we'll simulate the report generation process

    // Update report's lastGeneratedAt
    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, reportId));

    // Simulate processing (in production, this would be async)
    setTimeout(async () => {
      try {
        await db
          .update(reportRuns)
          .set({
            status: 'completed',
            completedAt: new Date(),
            outputUrl: `/api/reports/runs/${run.id}/download`
          })
          .where(eq(reportRuns.id, run.id));
      } catch {
        await db
          .update(reportRuns)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errorMessage: 'Failed to generate report'
          })
          .where(eq(reportRuns.id, run.id));
      }
    }, 1000);

    return c.json({
      message: 'Report generation started',
      runId: run.id,
      status: run.status
    });
  }
);

// ============================================
// REPORT GENERATION ENDPOINTS
// ============================================

// POST /reports/generate - Generate ad-hoc report
reportRoutes.post(
  '/generate',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', generateReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    // Generate report data based on type
    let reportData: unknown;
    const config = data.config || {};

    switch (data.type) {
      case 'device_inventory':
        reportData = await generateDeviceInventoryReport(orgId!, config);
        break;
      case 'software_inventory':
        reportData = await generateSoftwareInventoryReport(orgId!, config);
        break;
      case 'alert_summary':
        reportData = await generateAlertSummaryReport(orgId!, config);
        break;
      case 'compliance':
        reportData = await generateComplianceReport(orgId!, config);
        break;
      case 'performance':
        reportData = await generatePerformanceReport(orgId!, config);
        break;
      case 'executive_summary':
        reportData = await generateExecutiveSummaryReport(orgId!, config);
        break;
      default:
        return c.json({ error: 'Invalid report type' }, 400);
    }

    return c.json({
      type: data.type,
      format: data.format,
      generatedAt: new Date().toISOString(),
      data: reportData
    });
  }
);

// GET /reports/runs - List recent report runs
reportRoutes.get(
  '/runs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listRunsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(reports.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      const partnerOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, auth.partnerId as string));

      const orgIds = partnerOrgs.map(o => o.id);
      if (orgIds.length === 0) {
        return c.json({
          data: [],
          pagination: { page, limit, total: 0 }
        });
      }
      conditions.push(inArray(reports.orgId, orgIds));
    }

    // Additional filters
    if (query.reportId) {
      conditions.push(eq(reportRuns.reportId, query.reportId));
    }

    if (query.status) {
      conditions.push(eq(reportRuns.status, query.status));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get runs with report info
    const runsList = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        status: reportRuns.status,
        startedAt: reportRuns.startedAt,
        completedAt: reportRuns.completedAt,
        outputUrl: reportRuns.outputUrl,
        errorMessage: reportRuns.errorMessage,
        rowCount: reportRuns.rowCount,
        createdAt: reportRuns.createdAt,
        reportName: reports.name,
        reportType: reports.type
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(whereCondition)
      .orderBy(desc(reportRuns.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: runsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /reports/runs/:id - Get run with download URL
reportRoutes.get(
  '/runs/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id');

    const run = await getReportRunWithOrgCheck(runId, auth);
    if (!run) {
      return c.json({ error: 'Report run not found' }, 404);
    }

    // Get the associated report
    const [report] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, run.reportId))
      .limit(1);

    return c.json({
      ...run,
      report: report ? {
        id: report.id,
        name: report.name,
        type: report.type,
        format: report.format
      } : null
    });
  }
);

// ============================================
// DATA ENDPOINTS
// ============================================

// GET /reports/data/device-inventory - Device inventory data
reportRoutes.get(
  '/data/device-inventory',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: [], total: 0 });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      conditions.push(eq(devices.siteId, query.siteId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const limit = Math.min(1000, Number.parseInt(query.limit ?? '100', 10) || 100);
    const offset = Number.parseInt(query.offset ?? '0', 10) || 0;

    // Get device inventory with hardware info
    const deviceList = await db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        osVersion: devices.osVersion,
        architecture: devices.architecture,
        agentVersion: devices.agentVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        enrolledAt: devices.enrolledAt,
        tags: devices.tags,
        siteId: devices.siteId,
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb,
        manufacturer: deviceHardware.manufacturer,
        model: deviceHardware.model,
        serialNumber: deviceHardware.serialNumber
      })
      .from(devices)
      .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
      .where(whereCondition)
      .orderBy(desc(devices.lastSeenAt))
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);

    return c.json({
      data: deviceList,
      total: Number(countResult[0]?.count ?? 0)
    });
  }
);

// GET /reports/data/software-inventory - Software across all devices
reportRoutes.get(
  '/data/software-inventory',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: [], total: 0 });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      conditions.push(eq(devices.siteId, query.siteId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const limit = Math.min(1000, Number.parseInt(query.limit ?? '100', 10) || 100);
    const offset = Number.parseInt(query.offset ?? '0', 10) || 0;

    // Get software inventory with device info
    const softwareList = await db
      .select({
        id: deviceSoftware.id,
        name: deviceSoftware.name,
        version: deviceSoftware.version,
        publisher: deviceSoftware.publisher,
        installDate: deviceSoftware.installDate,
        isSystem: deviceSoftware.isSystem,
        deviceId: deviceSoftware.deviceId,
        deviceHostname: devices.hostname
      })
      .from(deviceSoftware)
      .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
      .where(whereCondition)
      .orderBy(deviceSoftware.name)
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceSoftware)
      .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
      .where(whereCondition);

    // Get aggregated software summary
    const softwareSummary = await db
      .select({
        name: deviceSoftware.name,
        version: deviceSoftware.version,
        deviceCount: sql<number>`count(distinct ${deviceSoftware.deviceId})`
      })
      .from(deviceSoftware)
      .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(deviceSoftware.name, deviceSoftware.version)
      .orderBy(desc(sql`count(distinct ${deviceSoftware.deviceId})`))
      .limit(50);

    return c.json({
      data: softwareList,
      summary: softwareSummary,
      total: Number(countResult[0]?.count ?? 0)
    });
  }
);

// GET /reports/data/alerts-summary - Alert statistics
reportRoutes.get(
  '/data/alerts-summary',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: { bySeverity: {}, byStatus: {}, byDay: [], topRules: [] }, total: 0 });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(alerts.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(alerts.orgId, orgIds));
    }

    if (query.startDate) {
      conditions.push(gte(alerts.triggeredAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(alerts.triggeredAt, new Date(query.endDate)));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get counts by severity
    const bySeverity = await db
      .select({
        severity: alerts.severity,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(whereCondition)
      .groupBy(alerts.severity);

    // Get counts by status
    const byStatus = await db
      .select({
        status: alerts.status,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(whereCondition)
      .groupBy(alerts.status);

    // Get alerts by day (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const byDay = await db
      .select({
        date: sql<string>`date_trunc('day', ${alerts.triggeredAt})::date`,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(
        conditions.length > 0
          ? and(...conditions, gte(alerts.triggeredAt, thirtyDaysAgo))
          : gte(alerts.triggeredAt, thirtyDaysAgo)
      )
      .groupBy(sql`date_trunc('day', ${alerts.triggeredAt})`)
      .orderBy(sql`date_trunc('day', ${alerts.triggeredAt})`);

    // Get top alerting rules
    const topRules = await db
      .select({
        ruleId: alerts.ruleId,
        ruleName: alertRules.name,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .where(whereCondition)
      .groupBy(alerts.ruleId, alertRules.name)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(whereCondition);

    return c.json({
      data: {
        bySeverity: Object.fromEntries(bySeverity.map(r => [r.severity, Number(r.count)])),
        byStatus: Object.fromEntries(byStatus.map(r => [r.status, Number(r.count)])),
        byDay: byDay.map(r => ({ date: r.date, count: Number(r.count) })),
        topRules: topRules.map(r => ({ ruleId: r.ruleId, ruleName: r.ruleName, count: Number(r.count) }))
      },
      total: Number(countResult[0]?.count ?? 0)
    });
  }
);

// GET /reports/data/compliance - Compliance summary
reportRoutes.get(
  '/data/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: { overview: {}, byOsType: [], agentVersions: [], issues: [] } });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      conditions.push(eq(devices.siteId, query.siteId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total device count
    const totalDevices = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);

    // Get devices by status
    const byStatus = await db
      .select({
        status: devices.status,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(whereCondition)
      .groupBy(devices.status);

    // Get devices by OS type
    const byOsType = await db
      .select({
        osType: devices.osType,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(whereCondition)
      .groupBy(devices.osType);

    // Get agent version distribution
    const agentVersions = await db
      .select({
        version: devices.agentVersion,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(whereCondition)
      .groupBy(devices.agentVersion)
      .orderBy(desc(sql`count(*)`));

    // Calculate compliance metrics
    const total = Number(totalDevices[0]?.count ?? 0);
    const onlineCount = byStatus.find(s => s.status === 'online')?.count ?? 0;
    const offlineCount = byStatus.find(s => s.status === 'offline')?.count ?? 0;
    const maintenanceCount = byStatus.find(s => s.status === 'maintenance')?.count ?? 0;

    // Get devices not seen in last 7 days (stale devices)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const staleDevices = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(
        conditions.length > 0
          ? and(...conditions, lte(devices.lastSeenAt, sevenDaysAgo))
          : lte(devices.lastSeenAt, sevenDaysAgo)
      );

    // Identify potential compliance issues
    const issues = [];

    const staleCount = Number(staleDevices[0]?.count ?? 0);
    if (staleCount > 0) {
      issues.push({
        type: 'stale_devices',
        severity: 'warning',
        count: staleCount,
        message: `${staleCount} device(s) haven't checked in for 7+ days`
      });
    }

    if (agentVersions.length > 1) {
      const latestVersion = agentVersions[0]?.version;
      const outdatedCount = agentVersions
        .filter(v => v.version !== latestVersion)
        .reduce((sum, v) => sum + Number(v.count), 0);

      if (outdatedCount > 0) {
        issues.push({
          type: 'outdated_agents',
          severity: 'info',
          count: outdatedCount,
          message: `${outdatedCount} device(s) running outdated agent versions`
        });
      }
    }

    const complianceScore = total > 0 ? Math.round(((Number(onlineCount) + Number(maintenanceCount)) / total) * 100) : 100;

    return c.json({
      data: {
        overview: {
          totalDevices: total,
          onlineDevices: Number(onlineCount),
          offlineDevices: Number(offlineCount),
          maintenanceDevices: Number(maintenanceCount),
          staleDevices: staleCount,
          complianceScore
        },
        byOsType: byOsType.map(r => ({ osType: r.osType, count: Number(r.count) })),
        agentVersions: agentVersions.map(r => ({ version: r.version, count: Number(r.count) })),
        issues
      }
    });
  }
);

// GET /reports/data/metrics - Performance metrics summary
reportRoutes.get(
  '/data/metrics',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: { averages: {}, topCpu: [], topRam: [], topDisk: [] } });
    }

    // Build conditions for devices
    const deviceConditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      deviceConditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      deviceConditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      deviceConditions.push(eq(devices.siteId, query.siteId));
    }

    const deviceWhereCondition = deviceConditions.length > 0 ? and(...deviceConditions) : undefined;

    // Get device IDs for the org
    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(deviceWhereCondition);

    const deviceIds = orgDevices.map(d => d.id);

    if (deviceIds.length === 0) {
      return c.json({
        data: {
          averages: { cpu: 0, ram: 0, disk: 0 },
          topCpu: [],
          topRam: [],
          topDisk: []
        }
      });
    }

    // Build time range conditions
    const metricsConditions: ReturnType<typeof eq>[] = [
      inArray(deviceMetrics.deviceId, deviceIds)
    ];

    if (query.startDate) {
      metricsConditions.push(gte(deviceMetrics.timestamp, new Date(query.startDate)));
    }

    if (query.endDate) {
      metricsConditions.push(lte(deviceMetrics.timestamp, new Date(query.endDate)));
    }

    const metricsWhereCondition = and(...metricsConditions);

    // Get average metrics
    const averages = await db
      .select({
        avgCpu: sql<number>`avg(${deviceMetrics.cpuPercent})`,
        avgRam: sql<number>`avg(${deviceMetrics.ramPercent})`,
        avgDisk: sql<number>`avg(${deviceMetrics.diskPercent})`
      })
      .from(deviceMetrics)
      .where(metricsWhereCondition);

    // Get latest metrics per device for top consumers
    const latestMetrics = await db
      .select({
        deviceId: deviceMetrics.deviceId,
        hostname: devices.hostname,
        cpuPercent: deviceMetrics.cpuPercent,
        ramPercent: deviceMetrics.ramPercent,
        diskPercent: deviceMetrics.diskPercent,
        timestamp: deviceMetrics.timestamp
      })
      .from(deviceMetrics)
      .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
      .where(inArray(deviceMetrics.deviceId, deviceIds))
      .orderBy(desc(deviceMetrics.timestamp))
      .limit(100);

    // Get unique latest metrics per device
    const latestPerDevice = new Map<string, typeof latestMetrics[0]>();
    for (const metric of latestMetrics) {
      if (!latestPerDevice.has(metric.deviceId)) {
        latestPerDevice.set(metric.deviceId, metric);
      }
    }

    const latestArray = Array.from(latestPerDevice.values());

    // Sort by each metric to get top consumers
    const topCpu = [...latestArray]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 10)
      .map(m => ({ deviceId: m.deviceId, hostname: m.hostname, value: m.cpuPercent }));

    const topRam = [...latestArray]
      .sort((a, b) => b.ramPercent - a.ramPercent)
      .slice(0, 10)
      .map(m => ({ deviceId: m.deviceId, hostname: m.hostname, value: m.ramPercent }));

    const topDisk = [...latestArray]
      .sort((a, b) => b.diskPercent - a.diskPercent)
      .slice(0, 10)
      .map(m => ({ deviceId: m.deviceId, hostname: m.hostname, value: m.diskPercent }));

    return c.json({
      data: {
        averages: {
          cpu: Math.round((averages[0]?.avgCpu ?? 0) * 10) / 10,
          ram: Math.round((averages[0]?.avgRam ?? 0) * 10) / 10,
          disk: Math.round((averages[0]?.avgDisk ?? 0) * 10) / 10
        },
        topCpu,
        topRam,
        topDisk
      }
    });
  }
);

// ============================================
// REPORT GENERATION HELPERS
// ============================================

async function generateDeviceInventoryReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  if (filters?.osTypes && Array.isArray(filters.osTypes) && filters.osTypes.length > 0) {
    conditions.push(inArray(devices.osType, filters.osTypes));
  }

  const whereCondition = and(...conditions);

  const data = await db
    .select({
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      enrolledAt: devices.enrolledAt,
      cpuModel: deviceHardware.cpuModel,
      ramTotalMb: deviceHardware.ramTotalMb,
      diskTotalGb: deviceHardware.diskTotalGb,
      serialNumber: deviceHardware.serialNumber
    })
    .from(devices)
    .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
    .where(whereCondition)
    .orderBy(devices.hostname);

  return { rows: data, rowCount: data.length };
}

async function generateSoftwareInventoryReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.deviceIds && Array.isArray(filters.deviceIds) && filters.deviceIds.length > 0) {
    conditions.push(inArray(devices.id, filters.deviceIds));
  }

  const whereCondition = and(...conditions);

  const data = await db
    .select({
      softwareName: deviceSoftware.name,
      version: deviceSoftware.version,
      publisher: deviceSoftware.publisher,
      installDate: deviceSoftware.installDate,
      deviceHostname: devices.hostname
    })
    .from(deviceSoftware)
    .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
    .where(whereCondition)
    .orderBy(deviceSoftware.name, devices.hostname);

  return { rows: data, rowCount: data.length };
}

async function generateAlertSummaryReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(alerts.orgId, orgId)];

  const dateRange = config.dateRange as Record<string, string> | undefined;
  if (dateRange?.start) {
    conditions.push(gte(alerts.triggeredAt, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    conditions.push(lte(alerts.triggeredAt, new Date(dateRange.end)));
  }

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.severity && Array.isArray(filters.severity) && filters.severity.length > 0) {
    conditions.push(inArray(alerts.severity, filters.severity));
  }

  const whereCondition = and(...conditions);

  const data = await db
    .select({
      title: alerts.title,
      severity: alerts.severity,
      status: alerts.status,
      triggeredAt: alerts.triggeredAt,
      acknowledgedAt: alerts.acknowledgedAt,
      resolvedAt: alerts.resolvedAt,
      deviceHostname: devices.hostname,
      ruleName: alertRules.name
    })
    .from(alerts)
    .leftJoin(devices, eq(alerts.deviceId, devices.id))
    .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
    .where(whereCondition)
    .orderBy(desc(alerts.triggeredAt));

  // Summary stats
  const summary = await db
    .select({
      severity: alerts.severity,
      count: sql<number>`count(*)`
    })
    .from(alerts)
    .where(whereCondition)
    .groupBy(alerts.severity);

  return {
    rows: data,
    rowCount: data.length,
    summary: Object.fromEntries(summary.map(s => [s.severity, Number(s.count)]))
  };
}

async function generateComplianceReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  const whereCondition = and(...conditions);

  // Get device compliance status
  const deviceList = await db
    .select({
      hostname: devices.hostname,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(whereCondition)
    .orderBy(devices.hostname);

  // Determine compliance status for each device
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const rows = deviceList.map(device => ({
    ...device,
    isCompliant: device.status !== 'decommissioned' &&
      device.lastSeenAt != null &&
      new Date(device.lastSeenAt) > sevenDaysAgo,
    issues: [
      device.status === 'offline' ? 'Device offline' : null,
      device.lastSeenAt && new Date(device.lastSeenAt) < sevenDaysAgo ? 'Not seen in 7+ days' : null
    ].filter(Boolean)
  }));

  const compliantCount = rows.filter(r => r.isCompliant).length;

  return {
    rows,
    rowCount: rows.length,
    summary: {
      totalDevices: rows.length,
      compliantDevices: compliantCount,
      nonCompliantDevices: rows.length - compliantCount,
      complianceRate: rows.length > 0 ? Math.round((compliantCount / rows.length) * 100) : 100
    }
  };
}

async function generatePerformanceReport(orgId: string, config: Record<string, unknown>) {
  const orgDevices = await db
    .select({ id: devices.id, hostname: devices.hostname })
    .from(devices)
    .where(eq(devices.orgId, orgId));

  const deviceIds = orgDevices.map(d => d.id);

  if (deviceIds.length === 0) {
    return { rows: [], rowCount: 0 };
  }

  const conditions: ReturnType<typeof eq>[] = [inArray(deviceMetrics.deviceId, deviceIds)];

  const dateRange = config.dateRange as Record<string, string> | undefined;
  if (dateRange?.start) {
    conditions.push(gte(deviceMetrics.timestamp, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    conditions.push(lte(deviceMetrics.timestamp, new Date(dateRange.end)));
  }

  const whereCondition = and(...conditions);

  // Get aggregated metrics per device
  const data = await db
    .select({
      deviceId: deviceMetrics.deviceId,
      hostname: devices.hostname,
      avgCpu: sql<number>`avg(${deviceMetrics.cpuPercent})`,
      maxCpu: sql<number>`max(${deviceMetrics.cpuPercent})`,
      avgRam: sql<number>`avg(${deviceMetrics.ramPercent})`,
      maxRam: sql<number>`max(${deviceMetrics.ramPercent})`,
      avgDisk: sql<number>`avg(${deviceMetrics.diskPercent})`,
      maxDisk: sql<number>`max(${deviceMetrics.diskPercent})`
    })
    .from(deviceMetrics)
    .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
    .where(whereCondition)
    .groupBy(deviceMetrics.deviceId, devices.hostname)
    .orderBy(devices.hostname);

  const rows = data.map(d => ({
    hostname: d.hostname,
    avgCpu: Math.round(d.avgCpu * 10) / 10,
    maxCpu: Math.round(d.maxCpu * 10) / 10,
    avgRam: Math.round(d.avgRam * 10) / 10,
    maxRam: Math.round(d.maxRam * 10) / 10,
    avgDisk: Math.round(d.avgDisk * 10) / 10,
    maxDisk: Math.round(d.maxDisk * 10) / 10
  }));

  return { rows, rowCount: rows.length };
}

async function generateExecutiveSummaryReport(orgId: string, config: Record<string, unknown>) {
  const dateRange = config.dateRange as Record<string, string> | undefined;

  // Device stats
  const deviceStats = await db
    .select({
      total: sql<number>`count(*)`,
      online: sql<number>`sum(case when ${devices.status} = 'online' then 1 else 0 end)`,
      offline: sql<number>`sum(case when ${devices.status} = 'offline' then 1 else 0 end)`
    })
    .from(devices)
    .where(eq(devices.orgId, orgId));

  // Alert stats
  const alertConditions: ReturnType<typeof eq>[] = [eq(alerts.orgId, orgId)];
  if (dateRange?.start) {
    alertConditions.push(gte(alerts.triggeredAt, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    alertConditions.push(lte(alerts.triggeredAt, new Date(dateRange.end)));
  }

  const alertStats = await db
    .select({
      total: sql<number>`count(*)`,
      critical: sql<number>`sum(case when ${alerts.severity} = 'critical' then 1 else 0 end)`,
      high: sql<number>`sum(case when ${alerts.severity} = 'high' then 1 else 0 end)`,
      resolved: sql<number>`sum(case when ${alerts.status} = 'resolved' then 1 else 0 end)`
    })
    .from(alerts)
    .where(and(...alertConditions));

  // OS distribution
  const osDistribution = await db
    .select({
      osType: devices.osType,
      count: sql<number>`count(*)`
    })
    .from(devices)
    .where(eq(devices.orgId, orgId))
    .groupBy(devices.osType);

  // Site breakdown
  const siteBreakdown = await db
    .select({
      siteName: sites.name,
      deviceCount: sql<number>`count(*)`
    })
    .from(devices)
    .innerJoin(sites, eq(devices.siteId, sites.id))
    .where(eq(devices.orgId, orgId))
    .groupBy(sites.name)
    .orderBy(desc(sql`count(*)`));

  return {
    summary: {
      devices: {
        total: Number(deviceStats[0]?.total ?? 0),
        online: Number(deviceStats[0]?.online ?? 0),
        offline: Number(deviceStats[0]?.offline ?? 0),
        healthPercentage: deviceStats[0]?.total
          ? Math.round((Number(deviceStats[0]?.online ?? 0) / Number(deviceStats[0]?.total)) * 100)
          : 100
      },
      alerts: {
        total: Number(alertStats[0]?.total ?? 0),
        critical: Number(alertStats[0]?.critical ?? 0),
        high: Number(alertStats[0]?.high ?? 0),
        resolved: Number(alertStats[0]?.resolved ?? 0),
        resolutionRate: alertStats[0]?.total
          ? Math.round((Number(alertStats[0]?.resolved ?? 0) / Number(alertStats[0]?.total)) * 100)
          : 100
      },
      osDistribution: Object.fromEntries(osDistribution.map(o => [o.osType, Number(o.count)])),
      siteBreakdown: siteBreakdown.map(s => ({ site: s.siteName, count: Number(s.deviceCount) }))
    },
    generatedAt: new Date().toISOString()
  };
}
